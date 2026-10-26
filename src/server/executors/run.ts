/**
 * The one orchestration entry for generation: allowance check, estimate, idempotent admission by
 * requestId, submit, poll, retrieve into the managed media folder, and the atomic output commit.
 * Every step is resumable from the stored job alone, so restart recovery is `listUnfinished()` plus
 * `advanceGeneration`, and a serial per-target runner (B8) can wrap these functions unchanged.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Recipe } from "@/lib/catalog";
import type { Asset } from "@/lib/domain/asset";
import {
  type GenerationInput,
  type GenerationTarget,
  type Job,
  type JobError,
  type JobInput,
  createJob,
  sameRequest,
} from "@/lib/domain/job";
import { effectiveAllowanceUsd } from "@/lib/domain/workspace";
import { type AllowanceState, checkAllowance, readAllowanceUsd, settleUsd } from "@/server/executors/allowance";
import type { ExecutorSet } from "@/server/executors/index";
import { claimForSubmit, failJob, jobError, toJobError } from "@/server/executors/jobs";
import type { Executor, PollOutcome, RetrieveDestination, RetrieveOutcome, SubmitOutcome } from "@/server/executors/types";
import { type StagedOutput, commitJobOutputs } from "@/server/media/commit";
import { resolveMediaPath } from "@/server/media/paths";
import { extractPoster } from "@/server/media/video";
import type { Store } from "@/server/store";

export interface RunDeps {
  store: Store;
  executors: ExecutorSet;
  /** Paid cap in USD; defaults to the lower of the workspace allowance and GENERATION_ALLOWANCE_USD. */
  allowanceUsd?: () => number;
  now?: () => number;
  newId?: () => string;
  sleep?: (ms: number) => Promise<unknown>;
  /** Writes a poster frame for an MP4 output; defaults to ffmpeg. Failures leave the asset without a poster. */
  poster?: (videoPath: string, posterPath: string) => Promise<void>;
}

export interface RunRequest {
  /** Caller-chosen idempotent id: the same requestId always maps to the same job. */
  requestId: string;
  projectId: string;
  recipe: Recipe;
  input: GenerationInput;
  inputs?: JobInput[];
  target?: GenerationTarget;
}

export type StartOutcome =
  /** Admitted and sent. For Router the submission runs on in `settled`; poll the job meanwhile. */
  | { kind: "started"; job: Job; settled: Promise<SubmitOutcome> }
  | { kind: "existing"; job: Job }
  | { kind: "needs_confirmation"; reserveUsd: number; reason: string }
  | { kind: "blocked"; error: JobError }
  | { kind: "failed"; job: Job | null; error: JobError };

export type StepOutcome =
  | { kind: "completed"; job: Job; assets: Asset[] }
  | { kind: "failed"; job: Job; error: JobError }
  | { kind: "waiting"; job: Job; retryAfterMs: number; queuePosition: number | null; uncertain: boolean };

const MEDIA_FOLDER = "media";

function clock(deps: RunDeps): number {
  return (deps.now ?? Date.now)();
}

/** Spent and reserved USD across all paid jobs, for the allowance gate. */
export function allowanceState(deps: RunDeps): AllowanceState {
  const allowanceUsd = deps.allowanceUsd
    ? deps.allowanceUsd()
    : effectiveAllowanceUsd(deps.store.workspace.get(), readAllowanceUsd());
  let spentUsd = 0;
  let reservedUsd = 0;
  for (const job of deps.store.jobs.listAll()) {
    if (job.executor === "mock") continue;
    if (job.status === "completed" || job.status === "failed") spentUsd += settleUsd(job.creditsUsed, job.reservedUsd ?? 0);
    else reservedUsd += job.reservedUsd ?? 0;
  }
  return { allowanceUsd, spentUsd, reservedUsd };
}

function executorFor(deps: RunDeps, job: Pick<Job, "request">): Executor | undefined {
  return deps.executors.forRecipe(job.request.recipe);
}

/** Starts the provider submission; Router answers only when the generation finishes, so it runs detached. */
async function dispatch(deps: RunDeps, executor: Executor, job: Job): Promise<{ job: Job; settled: Promise<SubmitOutcome> }> {
  const claimed = claimForSubmit(deps.store.jobs, job, clock(deps)) ?? job;
  const settled = executor.submit(claimed);
  if (executor.kind === "router") {
    settled.catch(() => undefined);
    return { job: claimed, settled };
  }
  const outcome = await settled;
  return { job: deps.store.jobs.get(job.id) ?? outcome.job ?? claimed, settled: Promise.resolve(outcome) };
}

/**
 * Admits and submits one generation. A repeated requestId returns the existing job without
 * estimating or sending anything. Paid runs need allowance; unquoted ones need `confirmUnquoted`.
 */
export async function startGeneration(
  deps: RunDeps,
  request: RunRequest,
  options: { confirmUnquoted?: boolean } = {},
): Promise<StartOutcome> {
  const jobRequest = { recipe: request.recipe, input: request.input, inputs: request.inputs ?? [], target: request.target ?? { kind: "loose" as const } };
  const existing = deps.store.jobs.getByRequest(request.requestId);
  if (existing) {
    if (existing.projectId !== request.projectId || !sameRequest(existing.request, jobRequest)) {
      return { kind: "failed", job: null, error: jobError("conflict", "This request id was already used for a different generation.") };
    }
    return { kind: "existing", job: existing };
  }
  const executor = deps.executors.forRecipe(request.recipe);
  if (!executor) {
    return { kind: "blocked", error: jobError("invalid", `${request.recipe.title} needs a Comfy API key in .env.local before it can run.`) };
  }
  const estimate = await executor.estimate({ requestId: request.requestId, projectId: request.projectId, recipe: request.recipe, input: request.input });
  const decision = checkAllowance(allowanceState(deps), estimate, request.recipe);
  if (decision.kind === "blocked") return { kind: "blocked", error: decision.error };
  if (decision.kind === "confirm" && !options.confirmUnquoted) {
    return { kind: "needs_confirmation", reserveUsd: decision.reserveUsd, reason: decision.reason };
  }
  const admitted = deps.store.jobs.add(
    createJob(
      {
        id: (deps.newId ?? randomUUID)(),
        requestId: request.requestId,
        projectId: request.projectId,
        request: jobRequest,
        reservedUsd: decision.reserveUsd > 0 ? decision.reserveUsd : null,
      },
      clock(deps),
    ),
  );
  if (!admitted.created) return { kind: "existing", job: admitted.job };
  try {
    const { job, settled } = await dispatch(deps, executor, admitted.job);
    if (job.status === "failed") return { kind: "failed", job, error: job.error };
    return { kind: "started", job, settled };
  } catch (cause) {
    return { kind: "failed", job: deps.store.jobs.get(admitted.job.id) ?? null, error: toJobError(cause) };
  }
}

async function commitRetrieved(deps: RunDeps, job: Job): Promise<StepOutcome> {
  const outputs: StagedOutput[] = [];
  for (const file of job.retrieved) {
    let posterPath: string | undefined;
    if (file.mime === "video/mp4") {
      const candidate = file.relativePath.replace(/\.mp4$/, "-poster.png");
      try {
        await (deps.poster ?? extractPoster)(resolveMediaPath(deps.store.dataDir, file.relativePath), resolveMediaPath(deps.store.dataDir, candidate));
        posterPath = candidate;
      } catch {
        posterPath = undefined;
      }
    }
    outputs.push({ retrieved: file, posterPath });
  }
  try {
    const result = await commitJobOutputs(deps.store, job, outputs, { now: clock(deps), newId: deps.newId ?? randomUUID });
    const saved = result.job;
    if (saved.status === "failed") return { kind: "failed", job: saved, error: saved.error };
    return { kind: "completed", job: saved, assets: deps.store.assets.list({ jobId: saved.id, state: "any" }).reverse() };
  } catch (cause) {
    const error = toJobError(cause, "The outputs could not be saved.");
    const current = deps.store.jobs.getRequired(job.id);
    if (current.status === "completed") return { kind: "completed", job: current, assets: deps.store.assets.list({ jobId: current.id, state: "any" }) };
    if (current.status === "failed") return { kind: "failed", job: current, error: current.error };
    return { kind: "failed", job: failJob(deps.store.jobs, current, error, clock(deps)), error };
  }
}

function waiting(outcome: Extract<PollOutcome, { kind: "pending" | "uncertain" }> | Extract<RetrieveOutcome, { kind: "retry" | "not_ready" }>): StepOutcome {
  const retryAfterMs = "retryAfterMs" in outcome ? outcome.retryAfterMs : 1000;
  const queuePosition = outcome.kind === "pending" ? outcome.queuePosition : null;
  return { kind: "waiting", job: outcome.job, retryAfterMs, queuePosition, uncertain: outcome.kind === "uncertain" };
}

/**
 * Moves one job forward by one step: submit an admitted job, poll, retrieve, or commit.
 * Safe to call repeatedly and after a restart; it reads everything it needs from the stored job.
 */
export async function advanceGeneration(deps: RunDeps, jobId: string): Promise<StepOutcome> {
  const job = deps.store.jobs.getRequired(jobId);
  if (job.status === "completed") return { kind: "completed", job, assets: deps.store.assets.list({ jobId, state: "any" }) };
  if (job.status === "failed") return { kind: "failed", job, error: job.error };
  const executor = executorFor(deps, job);
  if (!executor) {
    return { kind: "waiting", job, retryAfterMs: 60_000, queuePosition: null, uncertain: false };
  }
  if (job.status === "retrieving" && job.retrieved.length > 0) return commitRetrieved(deps, job);
  if (job.status === "queued" && job.providerRef === null) {
    const { job: sent } = await dispatch(deps, executor, job);
    if (sent.status === "failed") return { kind: "failed", job: sent, error: sent.error };
    return { kind: "waiting", job: sent, retryAfterMs: 1000, queuePosition: null, uncertain: false };
  }
  const polled = await executor.poll(jobId);
  if (polled.kind === "failed") return { kind: "failed", job: polled.job, error: polled.error };
  if (polled.kind === "pending" || polled.kind === "uncertain") return waiting(polled);
  const retrieved = await executor.retrieve(jobId, { root: deps.store.dataDir, folder: MEDIA_FOLDER });
  if (retrieved.kind === "failed") return { kind: "failed", job: retrieved.job, error: retrieved.error };
  if (retrieved.kind === "retry" || retrieved.kind === "not_ready") return waiting(retrieved);
  return commitRetrieved(deps, retrieved.job);
}

/** Advances a job until it completes, fails, or the deadline passes (the job stays recoverable). */
export async function runToCompletion(deps: RunDeps, jobId: string, options: { timeoutMs?: number } = {}): Promise<StepOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const deadline = clock(deps) + (options.timeoutMs ?? 30 * 60_000);
  while (true) {
    const step = await advanceGeneration(deps, jobId);
    if (step.kind !== "waiting" || clock(deps) + step.retryAfterMs > deadline) return step;
    await sleep(step.retryAfterMs);
  }
}

/** Restart recovery: one step for every unfinished job, oldest first. Schedule more from the results. */
export async function recoverUnfinished(deps: RunDeps): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const job of deps.store.jobs.listUnfinished()) {
    try {
      outcomes.push(await advanceGeneration(deps, job.id));
    } catch (cause) {
      const current = deps.store.jobs.getRequired(job.id);
      outcomes.push({ kind: "waiting", job: current, retryAfterMs: 60_000, queuePosition: null, uncertain: toJobError(cause).retryable });
    }
  }
  return outcomes;
}

/**
 * Executor-level loop without the store commit: polls until ready, then retrieves, retrying while
 * the failure is retryable. For executor tests and tools that only need the files.
 */
export async function pollAndRetrieve(
  executor: Executor,
  jobId: string,
  destination: RetrieveDestination,
  options: { sleep?: (ms: number) => Promise<unknown>; timeoutMs?: number; now?: () => number } = {},
): Promise<RetrieveOutcome | Extract<PollOutcome, { kind: "failed" | "uncertain" | "pending" }>> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 30 * 60_000);
  while (true) {
    const polled = await executor.poll(jobId);
    if (polled.kind === "failed") return polled;
    if (polled.kind === "ready" || polled.kind === "completed") {
      const retrieved = await executor.retrieve(jobId, destination);
      if (retrieved.kind !== "retry" && retrieved.kind !== "not_ready") return retrieved;
      if (now() + (retrieved.kind === "retry" ? retrieved.retryAfterMs : 0) > deadline) return retrieved;
      await sleep(retrieved.kind === "retry" ? retrieved.retryAfterMs : 1000);
      continue;
    }
    if (now() + polled.retryAfterMs > deadline) return polled;
    await sleep(polled.retryAfterMs);
  }
}
