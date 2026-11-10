/**
 * The one orchestration entry for generation: allowance check, estimate, idempotent admission by
 * requestId, submit, poll, retrieve into the managed media folder, and the atomic output commit.
 * Every step is resumable from the stored job alone, so restart recovery is `listUnfinished()` plus
 * `advanceGeneration`, and a serial per-target runner (B8) can wrap these functions unchanged.
 * @packageDocumentation
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Recipe } from "@creator-lab/core/catalog";
import type { Asset } from "@creator-lab/core/domain/asset";
import {
  type GenerationInput,
  type GenerationTarget,
  type Job,
  type JobError,
  type JobInput,
  createJob,
  sameRequest,
} from "@creator-lab/core/domain/job";
import type { ShotSpec } from "@creator-lab/core/domain/shot-spec";
import type { BudgetCrossing, SpendPolicy } from "@creator-lab/core/domain/spend";
import { markVerifiedRun } from "@/server/catalog/backends";
import { type AllowanceState, checkSpend } from "@creator-lab/executors/allowance";
import type { ExecutorSet } from "@creator-lab/executors";
import { COLLECTION_WINDOW_MS, type SpendDeps, currentSpendPolicy } from "@creator-lab/executors/spend";
import { claimForSubmit, failJob, jobError, patchJob, toJobError } from "@creator-lab/executors/jobs";
import { isEmptyOutput } from "@creator-lab/executors/media";
import type { Executor, PollOutcome, RetrieveDestination, RetrieveOutcome, SubmitOutcome } from "@creator-lab/executors/types";
import { type StagedOutput, commitJobOutputs } from "@/server/media/commit";
import { resolveMediaPath } from "@/server/media/paths";
import { extractPoster } from "@/server/media/video";
import type { Store } from "@/server/store";

export interface RunDeps extends SpendDeps {
  store: Store;
  executors: ExecutorSet;
  /**
   * A flat paid cap in USD that replaces the spend policy's budget, extension, and ceiling (tests
   * and scripts). Without it the gate is the monthly budget plus this period's extension, capped by
   * GENERATION_ALLOWANCE_USD.
   */
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
  /** The shot spec the prompt was rendered from; kept on the job for "Regenerate with...". */
  spec?: ShotSpec;
}

export type StartOutcome =
  /** Admitted and sent. For Router the submission runs on in `settled`; poll the job meanwhile. */
  | { kind: "started"; job: Job; settled: Promise<SubmitOutcome> }
  | { kind: "existing"; job: Job }
  | { kind: "needs_confirmation"; reserveUsd: number; reason: string }
  /** `budget` is set when the run would cross this period's remaining budget. */
  | { kind: "blocked"; error: JobError; budget?: BudgetCrossing }
  | { kind: "failed"; job: Job | null; error: JobError };

export type StepOutcome =
  | { kind: "completed"; job: Job; assets: Asset[] }
  /** `retry` is the one automatic re-run started after a black or empty output, when there is one. */
  | { kind: "failed"; job: Job; error: JobError; retry?: Job }
  | { kind: "waiting"; job: Job; retryAfterMs: number; queuePosition: number | null; uncertain: boolean };

const MEDIA_FOLDER = "media";

export { COLLECTION_WINDOW_MS, chargedUsd } from "@creator-lab/executors/spend";

export const UNCERTAIN_EXPIRED_NOTICE =
  "This request could not be confirmed within 23 hours, so its reservation was released and it will not be sent again. Check your Comfy usage before generating again.";

function clock(deps: RunDeps): number {
  return (deps.now ?? Date.now)();
}

/** The spend policy in force for these deps (this period's budget, extension, spend, and ceiling). */
export function spendPolicy(deps: RunDeps): SpendPolicy {
  return currentSpendPolicy(deps);
}

/** This period's effective limit, settled spend, and outstanding reservations. */
export function allowanceState(deps: RunDeps): AllowanceState {
  const policy = currentSpendPolicy(deps);
  return { allowanceUsd: policy.effectiveLimitUsd, spentUsd: policy.spentUsd, reservedUsd: policy.reservedUsd };
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
  const jobRequest = {
    recipe: request.recipe,
    input: request.input,
    inputs: request.inputs ?? [],
    target: request.target ?? { kind: "loose" as const },
    ...(request.spec ? { spec: request.spec } : {}),
  };
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
  const decision = checkSpend(currentSpendPolicy(deps), estimate, request.recipe);
  if (decision.kind === "blocked") return decision.budget ? { kind: "blocked", error: decision.error, budget: decision.budget } : { kind: "blocked", error: decision.error };
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

/**
 * The request id of the one automatic retry after a black or empty output: `<requestId>:retry1`,
 * hashed into the UUID form request ids take, so it is stable across restarts.
 */
export function retryRequestId(requestId: string): string {
  const hex = createHash("sha256").update(`${requestId}:retry1`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function retryNotice(originalJobId: string): string {
  return `Automatic retry with a new seed after job ${originalJobId} returned a black or empty output.`;
}

function hasSeedSlot(recipe: Recipe): boolean {
  if (recipe.kind === "workflow") return !!recipe.sidecar.slots.seed;
  if (recipe.kind === "router") return !!recipe.fieldMap.seed;
  return false;
}

/** The job this one automatically retries, if it is a retry. */
function retriedFrom(deps: RunDeps, job: Job): Job | undefined {
  return deps.store.jobs.listByProject(job.projectId).find((other) => other.id !== job.id && retryRequestId(other.requestId) === job.requestId);
}

/** A seed derived from the retry request id that differs from the one the failed run used. */
function retrySeed(requestId: string, previous: number | undefined): number {
  const seed = Number.parseInt(requestId.replaceAll("-", "").slice(0, 8), 16) % 2_147_483_647;
  return seed === previous ? (seed + 1) % 2_147_483_647 : seed;
}

/**
 * Starts the one automatic retry for a job that failed with a black or empty output, when the recipe
 * takes a seed, the job is not itself a retry, and the allowance still permits the run. Idempotent:
 * the derived request id maps a repeat call to the same retry job.
 */
export async function retryEmptyOutput(deps: RunDeps, failed: Job): Promise<Job | undefined> {
  if (failed.status !== "failed" || !isEmptyOutput(failed.error)) return undefined;
  const recipe = failed.request.recipe;
  if (!hasSeedSlot(recipe) || retriedFrom(deps, failed)) return undefined;
  const requestId = retryRequestId(failed.requestId);
  const existing = deps.store.jobs.getByRequest(requestId);
  if (existing) return existing;
  const outcome = await startGeneration(
    deps,
    {
      requestId,
      projectId: failed.projectId,
      recipe,
      input: { ...failed.request.input, seed: retrySeed(requestId, failed.request.input.seed) },
      inputs: failed.request.inputs,
      target: failed.request.target,
    },
    // The user already accepted this recipe's reservation once; the allowance cap is still checked.
    { confirmUnquoted: true },
  );
  if (outcome.kind !== "started" && outcome.kind !== "existing" && !(outcome.kind === "failed" && outcome.job)) return undefined;
  const job = outcome.kind === "failed" ? outcome.job! : outcome.job;
  return patchJob(deps.store.jobs, job, { notice: retryNotice(failed.id) }, clock(deps));
}

async function commitRetrieved(deps: RunDeps, staged: Job): Promise<StepOutcome> {
  const original = staged.notice === null ? retriedFrom(deps, staged) : undefined;
  const job = original ? patchJob(deps.store.jobs, staged, { notice: retryNotice(original.id) }, clock(deps)) : staged;
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
    // A finished run on a backend is what "verified" means there; the probe only says "compatible".
    const recipe = saved.request.recipe;
    if (recipe.kind === "workflow" && recipe.backendId) markVerifiedRun(deps.store, recipe.backendId, recipe.id, clock(deps));
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

/** A failed step, starting (or finding) the automatic retry when the failure was a black or empty output. */
async function failedStep(deps: RunDeps, job: Job): Promise<StepOutcome> {
  if (job.status !== "failed") return { kind: "failed", job: deps.store.jobs.getRequired(job.id), error: jobError("provider", "This job failed.") };
  const retry = isEmptyOutput(job.error) ? await retryEmptyOutput(deps, job) : undefined;
  return retry ? { kind: "failed", job, error: job.error, retry } : { kind: "failed", job, error: job.error };
}

/**
 * Moves one job forward by one step: submit an admitted job, poll, retrieve, or commit.
 * Safe to call repeatedly and after a restart; it reads everything it needs from the stored job.
 */
export async function advanceGeneration(deps: RunDeps, jobId: string): Promise<StepOutcome> {
  const job = deps.store.jobs.getRequired(jobId);
  if (job.status === "completed") return { kind: "completed", job, assets: deps.store.assets.list({ jobId, state: "any" }) };
  if (job.status === "failed") return failedStep(deps, job);
  const executor = executorFor(deps, job);
  if (!executor) {
    return { kind: "waiting", job, retryAfterMs: 60_000, queuePosition: null, uncertain: false };
  }
  if (job.status === "retrieving" && job.retrieved.length > 0) return commitRetrieved(deps, job);
  if (job.status === "uncertain" && clock(deps) - job.createdAt > COLLECTION_WINDOW_MS) {
    const expired = job.notice === UNCERTAIN_EXPIRED_NOTICE ? job : patchJob(deps.store.jobs, job, { notice: UNCERTAIN_EXPIRED_NOTICE }, clock(deps));
    return { kind: "waiting", job: expired, retryAfterMs: 60 * 60_000, queuePosition: null, uncertain: true };
  }
  if (job.status === "queued" && job.providerRef === null) {
    const { job: sent } = await dispatch(deps, executor, job);
    if (sent.status === "failed") return { kind: "failed", job: sent, error: sent.error };
    return { kind: "waiting", job: sent, retryAfterMs: 1000, queuePosition: null, uncertain: false };
  }
  const polled = await executor.poll(jobId);
  if (polled.kind === "failed") return { kind: "failed", job: polled.job, error: polled.error };
  if (polled.kind === "pending" || polled.kind === "uncertain") return waiting(polled);
  const retrieved = await executor.retrieve(jobId, { root: deps.store.dataDir, folder: MEDIA_FOLDER });
  if (retrieved.kind === "failed") return failedStep(deps, retrieved.job);
  if (retrieved.kind === "retry" || retrieved.kind === "not_ready") return waiting(retrieved);
  return commitRetrieved(deps, retrieved.job);
}

/** Advances a job until it completes, fails, or the deadline passes (the job stays recoverable). */
export async function runToCompletion(deps: RunDeps, jobId: string, options: { timeoutMs?: number } = {}): Promise<StepOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const deadline = clock(deps) + (options.timeoutMs ?? 30 * 60_000);
  let current = jobId;
  let followed = false;
  while (true) {
    const step = await advanceGeneration(deps, current);
    if (step.kind === "failed" && step.retry && !followed) {
      // Follow the one automatic retry; a failed retry is final.
      current = step.retry.id;
      followed = true;
      continue;
    }
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

/**
 * Restart recovery with a concurrency of one: one step for every unfinished job, then each job that
 * is still waiting is driven to the end before the next. Logs one line per job (id, recipe, outcome,
 * error code); never prompts, paths, or keys.
 */
export async function recoverAndDrain(deps: RunDeps, log: (line: string) => void = () => undefined): Promise<StepOutcome[]> {
  const finished: StepOutcome[] = [];
  for (const step of await recoverUnfinished(deps)) {
    let outcome = step;
    if (step.kind === "waiting" && !(step.uncertain && step.job.notice === UNCERTAIN_EXPIRED_NOTICE)) {
      try {
        outcome = await runToCompletion(deps, step.job.id);
      } catch (cause) {
        log(`[recovery] job ${step.job.id} (${step.job.recipeId}): stopped, ${toJobError(cause).code}`);
        finished.push(step);
        continue;
      }
    }
    const detail = outcome.kind === "failed" ? `failed, ${outcome.error.code}` : outcome.kind === "completed" ? `completed, ${outcome.assets.length} output(s)` : `still ${outcome.job.status}`;
    log(`[recovery] job ${outcome.job.id} (${outcome.job.recipeId}): ${detail}`);
    finished.push(outcome);
  }
  return finished;
}
