/**
 * Chained recordings (v0.2 F4): a clip longer than its recipe makes in one run, made as segments.
 * Each segment is an ordinary durable job (admitted, submitted, polled, retrieved, and committed by
 * `run.ts`, with uncertain-submission recovery and the one automatic retry after a black output),
 * started from the previous segment's handover frame (or, for speech to video, its slice of the
 * voice recording). The chain record (`store.chains`) says which job made which segment, so a
 * restart resumes exactly where it stopped. When every segment is in, they are stitched locally with
 * a short crossfade at each seam (the voice recording as the one audio track when the beat has
 * one), the seams are checked, and the stitched clip lands where the proposal aimed it, as one
 * candidate.
 *
 * Budget: admitting a chain reserves every segment at once. The whole recording must fit this
 * period's remaining budget before segment 1 runs, and segments not admitted yet stay held
 * (`chainHoldUsd`), so later spending cannot strand a half-paid recording. A segment that still
 * cannot be admitted pauses the chain with a notice and releases its hold; submitting the proposal
 * again re-checks the rest as a whole and resumes it. A chain never holds money it cannot use: an
 * input deleted under it, five local failures in a row, an uncertain segment past the collection
 * window, or a person's cancel ends it and releases the hold.
 * @packageDocumentation
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ChainDrive, ChainPlan, Recipe } from "@creator-lab/core/catalog";
import { type Asset, AssetSchema, archiveAsset } from "@creator-lab/core/domain/asset";
import { ServiceError, fail } from "@creator-lab/core/domain/failure";
import type { GenerationInput, GenerationTarget, Job, JobError, JobInput } from "@creator-lab/core/domain/job";
import type { ShotSpec } from "@creator-lab/core/domain/shot-spec";
import { type BudgetCrossing, budgetCrossing, describeCrossing } from "@creator-lab/core/domain/spend";
import { PAID_GENERATION_OFF, reservationUsd } from "@creator-lab/executors/allowance";
import { type Chain, type ChainSegment, type ChainView, chainReserveUsd, isChainActive, isChainFinal, updateChain, withSegment } from "@creator-lab/executors/chain";
import { jobError, toJobError } from "@creator-lab/executors/jobs";
import { currentSpendPolicy } from "@creator-lab/executors/spend";
import { SEAM_ISSUE_TEXT, type SeamReport, checkSeams, extractHandoverFrame, sliceAudio, stitchTake } from "@creator-lab/executors/stitch";
import { attachToTarget } from "@/server/media/commit";
import { removeMedia } from "@/server/media/files";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import { extractPoster } from "@/server/media/video";
import { type RunDeps, UNCERTAIN_EXPIRED_NOTICE, advanceGeneration, retryRequestId, startGeneration } from "@/server/generation/run";

/** What a proposal candidate turns into when its recording is chained. */
export interface NewChain {
  /** The candidate's request id; the same id always maps to the same chain. */
  requestId: string;
  projectId: string;
  /** The recipe snapshot every segment runs, bound to its backend. */
  recipe: Recipe;
  drive: ChainDrive;
  plan: ChainPlan;
  /** Each segment's words and rendered prompt, in order. */
  prompts: { line: string; prompt: string }[];
  spec: ShotSpec;
  /** The starting still first, then an identity reference when the recipe takes one, with their paths. */
  inputs: JobInput[];
  images: string[];
  /** The continuous voice recording: the clip's audio, and for speech to video what each segment follows. */
  spine: Asset | null;
  target: GenerationTarget;
  aspectRatio?: GenerationInput["aspectRatio"];
  seed?: number;
  slots?: GenerationInput["slots"];
}

export type ChainStart =
  | { kind: "started" | "existing"; chain: Chain; job: Job | null }
  | { kind: "needs_confirmation"; reserveUsd: number; reason: string }
  | { kind: "blocked"; error: JobError; budget?: BudgetCrossing }
  | { kind: "failed"; chain: Chain | null; error: JobError };

export type ChainStep =
  | { kind: "completed"; chain: Chain; asset: Asset }
  | { kind: "failed"; chain: Chain; error: JobError }
  | { kind: "paused"; chain: Chain }
  | { kind: "waiting"; chain: Chain; job: Job | null; retryAfterMs: number };

/** Local steps (a handover frame, a voice slice, the stitch) that may fail in a row before the chain gives up. */
export const MAX_LOCAL_FAILURES = 5;
/** Chains restart recovery resumes at once. */
export const RECOVERY_CONCURRENCY = 2;
export const CANCELED_CODE = "canceled";

const clock = (deps: RunDeps) => (deps.now ?? Date.now)();

/** Chains with a loop driving them in this process, so a resubmit or a poll starts one only when none is. */
const holder = globalThis as typeof globalThis & { __creatorLabChainLoops?: Set<string> };
const liveLoops = (holder.__creatorLabChainLoops ??= new Set<string>());

export function chainLoopRunning(chainId: string): boolean {
  return liveLoops.has(chainId);
}

/** A stable request id for a chain's segment, in the UUID form request ids take. */
export function segmentRequestId(chainRequestId: string, index: number): string {
  const hex = createHash("sha256").update(`${chainRequestId}:segment${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The semantic input of one segment's job. */
function segmentInput(chain: Pick<Chain, "images" | "aspectRatio" | "seed" | "slots">, segment: ChainSegment): GenerationInput {
  const [first, ...rest] = chain.images;
  return {
    prompt: segment.prompt,
    images: [segment.startFrame?.relativePath ?? first, ...rest],
    ...(segment.audio ? { audio: segment.audio.relativePath } : {}),
    ...(chain.aspectRatio ? { aspectRatio: chain.aspectRatio as GenerationInput["aspectRatio"] } : {}),
    durationSeconds: segment.durationSeconds,
    ...(chain.slots && Object.keys(chain.slots).length ? { slots: chain.slots } : {}),
    ...(chain.seed !== undefined ? { seed: chain.seed } : {}),
  };
}

/** Saves the next chain record; a lost race reloads, so callers always continue from what is stored. */
function save(deps: RunDeps, chain: Chain, patch: Parameters<typeof updateChain>[1]): Chain {
  const next = updateChain(chain, patch, clock(deps));
  if (!deps.store.chains.update(next)) return deps.store.chains.getRequired(chain.id);
  return next;
}

/** Saves progress on one segment, which also clears the run of local failures. */
function saveSegment(deps: RunDeps, chain: Chain, index: number, patch: Partial<ChainSegment>): Chain {
  return save(deps, chain, { segments: withSegment(chain, index, patch), localFailures: 0 });
}

function failChain(deps: RunDeps, chain: Chain, error: JobError, notice: string): ChainStep {
  const saved = save(deps, chain, { status: "failed", error, notice: notice.slice(0, 600) });
  return { kind: "failed", chain: saved, error };
}

function madeSoFar(chain: Chain): string {
  const made = chain.segments.filter((entry) => entry.assetId).length;
  return `The ${made} segment${made === 1 ? "" : "s"} already made ${made === 1 ? "is" : "are"} kept; the rest of the recording was not started and its reservation is released.`;
}

/**
 * A local step failed. An input that is gone (deleted, or missing on disk) ends the chain at once;
 * anything else waits and tries again, up to {@link MAX_LOCAL_FAILURES} in a row.
 */
function localFailure(deps: RunDeps, chainId: string, cause: unknown, what: string): ChainStep {
  const chain = deps.store.chains.getRequired(chainId);
  const gone = (cause instanceof ServiceError && cause.code === "not_found") || (cause as NodeJS.ErrnoException)?.code === "ENOENT";
  if (gone) return failChain(deps, chain, jobError("not_found", `${what}: an input is gone.`), `${what} failed because a file it needs was deleted. ${madeSoFar(chain)}`);
  const failures = chain.localFailures + 1;
  if (failures >= MAX_LOCAL_FAILURES) {
    return failChain(deps, chain, toJobError(cause, `${what} failed.`), `${what} failed ${failures} times in a row (${toJobError(cause).message}). ${madeSoFar(chain)}`);
  }
  const saved = save(deps, chain, { localFailures: failures });
  return { kind: "waiting", chain: saved, job: null, retryAfterMs: toJobError(cause).retryable ? 5000 : 30_000 };
}

/** An asset a chain step reads; a deleted or missing one is a not_found failure. */
function liveAsset(deps: RunDeps, assetId: string | null, what: string): Asset {
  const asset = assetId ? deps.store.assets.get(assetId) : undefined;
  if (!asset || asset.state.state === "deleted") fail("not_found", `${what} was deleted.`);
  return asset;
}

/** What every segment of a candidate would reserve, from the executor's own estimate. */
async function estimateSegments(deps: RunDeps, request: NewChain, segments: ChainSegment[]): Promise<{ reserves: number[]; unquoted: string | null } | { error: JobError }> {
  const executor = deps.executors.forRecipe(request.recipe);
  if (!executor) return { error: jobError("invalid", `${request.recipe.title} needs a Comfy API key in .env.local before it can run.`) };
  const reserves: number[] = [];
  let unquoted: string | null = null;
  for (const segment of segments) {
    const input = segmentInput({ images: request.images, aspectRatio: request.aspectRatio, seed: request.seed, slots: request.slots }, segment);
    const estimate = await executor.estimate({ requestId: segment.requestId, projectId: request.projectId, recipe: request.recipe, input });
    if (estimate.kind === "rejected") return { error: estimate.error };
    const reserve = reservationUsd(estimate, request.recipe);
    if (reserve === undefined) return { error: jobError("budget", `${request.recipe.title} has no price or ceiling, so it cannot be reserved against the budget.`) };
    if (estimate.kind === "unquoted") unquoted = estimate.note;
    reserves.push(reserve);
  }
  return { reserves, unquoted };
}

/** The whole recording checked against this period's remaining budget; null when it fits. */
function budgetBlock(deps: RunDeps, totalUsd: number): Extract<ChainStart, { kind: "blocked" }> | null {
  if (totalUsd <= 0) return null;
  const policy = currentSpendPolicy(deps);
  if (policy.ceilingUsd <= 0) return { kind: "blocked", error: jobError("budget", PAID_GENERATION_OFF) };
  const crossing = budgetCrossing(policy, totalUsd);
  return crossing ? { kind: "blocked", error: jobError("budget", `The whole recording is reserved before segment 1 runs. ${describeCrossing(crossing)}`), budget: crossing } : null;
}

/**
 * Admits a chained candidate: prices every segment, refuses the whole recording when it would cross
 * the remaining budget (nothing runs), saves the chain with every segment held, and starts segment
 * 1. A repeat returns the saved chain; a paused one is re-checked and resumed.
 */
export async function startChain(deps: RunDeps, request: NewChain, options: { confirmUnquoted?: boolean } = {}): Promise<ChainStart> {
  const existing = deps.store.chains.getByRequest(request.requestId);
  if (existing) {
    const owner = deps.store.projects.get(request.projectId)?.ownerId;
    if (existing.projectId !== request.projectId || existing.ownerId !== owner) return { kind: "failed", chain: null, error: jobError("conflict", "This request id was already used for a different recording.") };
    if (existing.status !== "paused") return { kind: "existing", chain: existing, job: currentJob(deps, existing) };
    return resumeChain(deps, existing);
  }
  const segments: ChainSegment[] = request.plan.segments.map((planned, position) => {
    const requestId = segmentRequestId(request.requestId, planned.index);
    return {
      index: planned.index,
      requestId,
      retryRequestId: retryRequestId(requestId),
      startSeconds: planned.startSeconds,
      durationSeconds: planned.durationSeconds,
      line: request.prompts[position].line.slice(0, 300),
      prompt: request.prompts[position].prompt,
      reserveUsd: 0,
      startFrame: null,
      audio: null,
      jobId: null,
      assetId: null,
    };
  });
  const priced = await estimateSegments(deps, request, segments);
  if ("error" in priced) return priced.error.code === "budget" ? { kind: "blocked", error: priced.error } : { kind: "failed", chain: null, error: priced.error };
  const totalUsd = Math.round(priced.reserves.reduce((sum, value) => sum + value, 0) * 1e6) / 1e6;
  const blocked = budgetBlock(deps, totalUsd);
  if (blocked) return blocked;
  if (priced.unquoted && !options.confirmUnquoted) {
    return { kind: "needs_confirmation", reserveUsd: totalUsd, reason: `${priced.unquoted} Up to $${totalUsd.toFixed(2)} will be reserved for the ${segments.length} segments of this recording.` };
  }
  const now = clock(deps);
  const added = deps.store.chains.add({
    id: (deps.newId ?? randomUUID)(),
    requestId: request.requestId,
    projectId: request.projectId,
    ownerId: deps.store.projects.get(request.projectId)?.ownerId ?? "local",
    recipe: request.recipe,
    drive: request.drive,
    totalSeconds: request.plan.totalSeconds,
    overlapSeconds: request.plan.overlapSeconds,
    ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.slots && Object.keys(request.slots).length ? { slots: request.slots } : {}),
    inputs: request.inputs,
    images: request.images,
    spine: request.spine?.audio
      ? { assetId: request.spine.id, sha256: request.spine.sha256, relativePath: request.spine.relativePath, durationSeconds: request.spine.audio.durationSeconds }
      : null,
    target: request.target,
    spec: request.spec,
    segments: segments.map((segment, position) => ({ ...segment, reserveUsd: priced.reserves[position] })),
    status: "running",
    notice: null,
    error: null,
    outputAssetId: null,
    seams: [],
    localFailures: 0,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
  if (!added.created) return { kind: "existing", chain: added.chain, job: currentJob(deps, added.chain) };
  const step = await advanceChain(deps, added.chain.id);
  if (step.kind === "failed") return { kind: "failed", chain: step.chain, error: step.error };
  return { kind: "started", chain: step.chain, job: currentJob(deps, step.chain) };
}

/** A paused chain's remaining segments, checked as a whole again, then resumed. */
async function resumeChain(deps: RunDeps, chain: Chain): Promise<ChainStart> {
  const remaining = chain.segments.filter((segment) => !deps.store.jobs.getByRequest(segment.requestId));
  const blocked = budgetBlock(deps, Math.round(remaining.reduce((sum, segment) => sum + segment.reserveUsd, 0) * 1e6) / 1e6);
  if (blocked) return blocked;
  const resumed = save(deps, chain, { status: "running", notice: null, localFailures: 0 });
  const step = await advanceChain(deps, resumed.id);
  if (step.kind === "failed") return { kind: "failed", chain: step.chain, error: step.error };
  return { kind: "started", chain: step.chain, job: currentJob(deps, step.chain) };
}

/**
 * Cancels a running, stitching, or paused chain: it ends as failed (code `canceled`) and holds
 * nothing from then on. The segment job in flight, if any, is asked to cancel; one the provider
 * already took keeps its own reservation until it settles. Segments already made are kept.
 */
export async function cancelChain(deps: RunDeps, chainId: string): Promise<Chain> {
  const chain = deps.store.chains.getRequired(chainId);
  if (isChainFinal(chain)) return chain;
  const inFlight = chain.segments.find((segment) => segment.jobId && !segment.assetId);
  const job = inFlight?.jobId ? deps.store.jobs.get(inFlight.jobId) : undefined;
  if (job && job.status !== "completed" && job.status !== "failed") {
    await deps.executors.forRecipe(job.request.recipe)?.cancel?.(job.id).catch(() => undefined);
  }
  const made = chain.segments.filter((segment) => segment.assetId).length;
  const notice = `Canceled after ${made} of ${chain.segments.length} segments. Nothing more will be generated for this recording and its reservation is released; segments already made are kept.`;
  const result = failChain(deps, deps.store.chains.getRequired(chainId), jobError("invalid", "Canceled.", false, CANCELED_CODE), notice);
  return result.chain;
}

/** The job of the segment in progress (or the last one), for the submit result. */
export function currentJob(deps: RunDeps, chain: Chain): Job | null {
  const segment = chain.segments.find((entry) => !entry.assetId) ?? chain.segments[chain.segments.length - 1];
  return segment.jobId ? (deps.store.jobs.get(segment.jobId) ?? null) : null;
}

async function writtenRef(deps: RunDeps, relativePath: string): Promise<{ relativePath: string; sha256: string }> {
  return { relativePath, sha256: sha256(await readFile(resolveMediaPath(deps.store.dataDir, relativePath))) };
}

/** Writes what a segment starts from: the previous segment's handover frame, and its slice of the voice recording. */
async function prepareSegment(deps: RunDeps, chain: Chain, segment: ChainSegment): Promise<Chain> {
  let current = chain;
  if (segment.index > 1 && !segment.startFrame) {
    const previous = current.segments[segment.index - 2];
    const asset = liveAsset(deps, previous.assetId, `Segment ${previous.index}`);
    const relativePath = `media/${chain.id}-segment-${segment.index}-start.png`;
    await extractHandoverFrame(resolveMediaPath(deps.store.dataDir, asset.relativePath), { frames: asset.video!.frameCount, fps: asset.video!.frameRate }, chain.overlapSeconds, resolveMediaPath(deps.store.dataDir, relativePath));
    current = saveSegment(deps, current, segment.index, { startFrame: await writtenRef(deps, relativePath) });
  }
  const fresh = current.segments[segment.index - 1];
  if (current.drive === "audio" && current.spine && !fresh.audio) {
    liveAsset(deps, current.spine.assetId, "The voice recording");
    const relativePath = `media/${chain.id}-segment-${segment.index}-voice.wav`;
    await sliceAudio(resolveMediaPath(deps.store.dataDir, current.spine.relativePath), fresh.startSeconds, fresh.durationSeconds, resolveMediaPath(deps.store.dataDir, relativePath));
    current = saveSegment(deps, current, segment.index, { audio: await writtenRef(deps, relativePath) });
  }
  return current;
}

/** Admits the next segment's job against the hold kept for it; pauses the chain when it cannot be admitted. */
async function admitSegment(deps: RunDeps, chain: Chain, segment: ChainSegment): Promise<ChainStep | Chain> {
  const prepared = await prepareSegment(deps, chain, segment);
  const ready = prepared.segments[segment.index - 1];
  // Nothing more is spent on a recording that could no longer be stitched: every input and every
  // segment made so far must still be there before the next segment is admitted.
  if (segment.index === 1) for (const pin of prepared.inputs) liveAsset(deps, pin.assetId, "The starting still");
  for (const made of prepared.segments) if (made.assetId) liveAsset(deps, made.assetId, `Segment ${made.index}`);
  if (prepared.spine) liveAsset(deps, prepared.spine.assetId, "The voice recording");
  // Segment jobs after the first start from a frame that is not an asset, so only the first pins its still.
  const inputs = segment.index === 1 ? prepared.inputs.slice(0, prepared.images.length) : [];
  const outcome = await startGeneration(
    deps,
    { requestId: ready.requestId, projectId: prepared.projectId, recipe: prepared.recipe, input: segmentInput(prepared, ready), inputs, target: prepared.target, spec: prepared.spec },
    // The person accepted the whole recording's reservation when the chain was admitted.
    { confirmUnquoted: true, heldFor: ready.requestId },
  );
  if (outcome.kind === "blocked" || outcome.kind === "needs_confirmation") {
    const why = outcome.kind === "blocked" ? outcome.error.message : outcome.reason;
    const done = prepared.segments.filter((entry) => entry.assetId).length;
    const notice = `Paused before segment ${segment.index} of ${prepared.segments.length} (${done} made and kept): ${why} Submit the proposal again to resume; the rest of the recording is checked against the budget as a whole.`;
    return { kind: "paused", chain: save(deps, prepared, { status: "paused", notice: notice.slice(0, 600) }) };
  }
  if (outcome.kind === "failed" && !outcome.job) {
    return failChain(deps, prepared, outcome.error, `Segment ${segment.index} of ${prepared.segments.length} could not be started: ${outcome.error.message} ${madeSoFar(prepared)}`);
  }
  const job = outcome.kind === "failed" ? outcome.job! : outcome.job;
  return saveSegment(deps, prepared, segment.index, { jobId: job.id });
}

/**
 * Moves a chain forward as far as it can without waiting: admits the next segment, advances the
 * segment job in progress, follows its automatic retry, and stitches once every segment is in.
 * Safe to call repeatedly and after a restart; everything it needs is in the stored chain and jobs.
 */
export async function advanceChain(deps: RunDeps, chainId: string): Promise<ChainStep> {
  for (let guard = 0; guard < 200; guard++) {
    const chain = deps.store.chains.getRequired(chainId);
    if (chain.status === "completed") return { kind: "completed", chain, asset: deps.store.assets.getRequired(chain.outputAssetId!) };
    if (chain.status === "failed") return { kind: "failed", chain, error: chain.error ?? jobError("provider", "This recording failed.") };
    if (chain.status === "paused") return { kind: "paused", chain };
    if (chain.status === "stitching") return stitchChain(deps, chain);
    const segment = chain.segments.find((entry) => !entry.assetId);
    if (!segment) {
      save(deps, chain, { status: "stitching", localFailures: 0 });
      continue;
    }
    const label = `Segment ${segment.index} of ${chain.segments.length}`;
    if (!segment.jobId) {
      // A crash between admitting the job and recording it leaves the job findable by its request id.
      const admitted = deps.store.jobs.getByRequest(segment.requestId);
      if (admitted) {
        saveSegment(deps, chain, segment.index, { jobId: admitted.id });
        continue;
      }
      let admittedStep: ChainStep | Chain;
      try {
        admittedStep = await admitSegment(deps, chain, segment);
      } catch (cause) {
        // Writing the handover frame or the voice slice is local and free: try again, a few times.
        return localFailure(deps, chainId, cause, `Preparing ${label.toLowerCase()}`);
      }
      if ("kind" in admittedStep) return admittedStep;
      continue;
    }
    const job = deps.store.jobs.getRequired(segment.jobId);
    if (job.status === "completed") {
      const asset = deps.store.assets.get(job.outputs[0]);
      if (!asset || asset.state.state === "deleted") return failChain(deps, chain, jobError("not_found", `${label} was deleted.`), `${label} was deleted before it could be handed over. ${madeSoFar(chain)}`);
      if (asset.mime !== "video/mp4" || !asset.video) {
        return failChain(deps, chain, jobError("invalid", "A chained recording needs real video segments."), `${label} came back as a ${asset.kind} file, not a video, so it cannot be handed over or stitched. The mock makes storyboards unless MOCK_VIDEO=mp4 is set.`);
      }
      saveSegment(deps, chain, segment.index, { assetId: asset.id });
      continue;
    }
    if (job.status === "failed") {
      const retry = deps.store.jobs.getByRequest(segment.retryRequestId);
      if (retry && retry.id !== job.id) {
        saveSegment(deps, chain, segment.index, { jobId: retry.id });
        continue;
      }
      const step = await advanceGeneration(deps, job.id);
      if (step.kind === "failed" && step.retry) {
        saveSegment(deps, chain, segment.index, { jobId: step.retry.id });
        continue;
      }
      return failChain(deps, chain, job.error, `${label} failed: ${job.error.message} ${madeSoFar(chain)}`);
    }
    let step;
    try {
      step = await advanceGeneration(deps, job.id);
    } catch (cause) {
      return localFailure(deps, chainId, cause, label);
    }
    if (step.kind === "waiting") {
      if (step.uncertain && step.job.notice === UNCERTAIN_EXPIRED_NOTICE) {
        return failChain(deps, chain, jobError("provider", UNCERTAIN_EXPIRED_NOTICE), `${label} could not be confirmed within 23 hours, so the recording stops here and its remaining reservation is released. Check your Comfy usage before generating again.`);
      }
      return { kind: "waiting", chain, job: step.job, retryAfterMs: step.retryAfterMs };
    }
  }
  return { kind: "waiting", chain: deps.store.chains.getRequired(chainId), job: null, retryAfterMs: 1000 };
}

/** What the seam check found, in words, or null when every seam is clean. */
export function seamNotice(seams: SeamReport[]): string | null {
  const flagged = seams.filter((seam) => seam.issues.length);
  if (!flagged.length) return null;
  const parts = flagged.map((seam) => `${seam.issues.map((issue) => SEAM_ISSUE_TEXT[issue]).join(" and ")} at ${seam.seconds.toFixed(1)} s`);
  return `Seam check: ${parts.join("; ")}. Look at those moments before approving; generating again makes every segment anew.`.slice(0, 600);
}

/** Stitches every segment, checks the seams, and commits the recording as one candidate where the proposal aimed it. */
async function stitchChain(deps: RunDeps, chain: Chain): Promise<ChainStep> {
  let segments: Asset[];
  try {
    segments = chain.segments.map((segment) => liveAsset(deps, segment.assetId, `Segment ${segment.index}`));
    if (chain.spine) liveAsset(deps, chain.spine.assetId, "The voice recording");
  } catch (cause) {
    return localFailure(deps, chain.id, cause, "Stitching the segments");
  }
  const first = segments[0];
  const assetId = (deps.newId ?? randomUUID)();
  const relativePath = `media/${assetId}.mp4`;
  const posterPath = `media/${assetId}-poster.png`;
  const absolute = resolveMediaPath(deps.store.dataDir, relativePath);
  let stitched;
  let seams: SeamReport[];
  try {
    stitched = await stitchTake({
      segments: segments.map((asset) => ({ path: resolveMediaPath(deps.store.dataDir, asset.relativePath), durationSeconds: asset.video!.durationSeconds, hasAudio: asset.video!.hasAudio })),
      overlapSeconds: chain.overlapSeconds,
      ...(chain.spine ? { spine: { path: resolveMediaPath(deps.store.dataDir, chain.spine.relativePath) } } : {}),
      width: first.width,
      height: first.height,
      fps: Math.round(first.video!.frameRate),
      out: absolute,
    });
    seams = await checkSeams(absolute, stitched.seams, stitched.info.durationSeconds);
  } catch (cause) {
    await rm(absolute, { force: true });
    // The stitch is local and free; it is tried again a few times before the chain gives up.
    return localFailure(deps, chain.id, cause, "Stitching the segments");
  }
  let poster: string | undefined = posterPath;
  try {
    await (deps.poster ?? extractPoster)(absolute, resolveMediaPath(deps.store.dataDir, posterPath));
  } catch {
    poster = undefined;
  }
  const now = clock(deps);
  const notice = seamNotice(seams);
  const asset = AssetSchema.parse({
    id: assetId,
    projectId: chain.projectId,
    ownerId: chain.ownerId,
    kind: "video",
    mime: "video/mp4",
    relativePath,
    width: stitched.info.width,
    height: stitched.info.height,
    sha256: sha256(await readFile(absolute)),
    provenance: {
      source: "generated",
      recipeId: chain.recipe.id,
      // Segment 1's job carries the shot spec and destination, so "Regenerate with..." finds them.
      jobId: chain.segments[0].jobId!,
      // The seam check's finding leads the record, so wherever the prompt is shown, it is too.
      prompt: [
        ...(notice ? [notice] : []),
        `Chained recording: ${chain.segments.length} segments, ${chain.overlapSeconds.toFixed(2)} s crossfades.`,
        ...chain.segments.map((segment) => `[Segment ${segment.index}] ${segment.prompt}`),
      ]
        .join("\n\n")
        .slice(0, 8000),
      inputs: [
        ...chain.inputs.map(({ assetId: id, sha256: hash }) => ({ assetId: id, sha256: hash })),
        ...(chain.spine ? [{ assetId: chain.spine.assetId, sha256: chain.spine.sha256 }] : []),
        ...segments.map((segment) => ({ assetId: segment.id, sha256: segment.sha256 })),
      ].slice(0, 16),
      mock: chain.recipe.kind === "mock",
    },
    state: { state: "active" },
    video: { durationSeconds: stitched.info.durationSeconds, frameRate: stitched.info.fps, frameCount: stitched.info.frames, hasAudio: stitched.info.hasAudio, ...(poster ? { posterPath: poster } : {}) },
    revision: 0,
    createdAt: now,
  });
  const committed = deps.store.transaction(() => {
    const current = deps.store.chains.getRequired(chain.id);
    if (current.status !== "stitching" || current.revision !== chain.revision) return false;
    deps.store.assets.insert(asset);
    attachToTarget(deps.store, chain.target, [asset.id], now);
    for (const segment of segments) {
      const stored = deps.store.assets.get(segment.id);
      if (stored?.state.state === "active") deps.store.assets.update(archiveAsset(stored, `Segment of a chained recording, stitched into ${asset.id.slice(0, 8)}`, now));
    }
    if (!deps.store.chains.update(updateChain(current, { status: "completed", outputAssetId: asset.id, seams, notice, localFailures: 0 }, now))) throw new Error("The chain moved on while it was being stitched.");
    return true;
  });
  if (!committed) {
    await removeMedia(deps.store.dataDir, [relativePath, ...(poster ? [poster] : [])]);
    return advanceChain(deps, chain.id);
  }
  return { kind: "completed", chain: deps.store.chains.getRequired(chain.id), asset };
}

/** Advances a chain until it completes, fails, pauses, or the deadline passes (it stays resumable). */
export async function runChainToCompletion(deps: RunDeps, chainId: string, options: { timeoutMs?: number } = {}): Promise<ChainStep> {
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const deadline = clock(deps) + (options.timeoutMs ?? 60 * 60_000);
  liveLoops.add(chainId);
  try {
    while (true) {
      const step = await advanceChain(deps, chainId);
      if (step.kind !== "waiting" || clock(deps) + step.retryAfterMs > deadline) return step;
      await sleep(step.retryAfterMs);
    }
  } finally {
    liveLoops.delete(chainId);
  }
}

/**
 * Starts a background loop for a running or stitching chain when none is driving it in this
 * process (after a restart, or when a loop reached its deadline). Returns whether it started one.
 */
export function ensureChainLoop(deps: RunDeps, chain: Pick<Chain, "id" | "status">): boolean {
  if (!isChainActive(chain) || liveLoops.has(chain.id)) return false;
  void runChainToCompletion(deps, chain.id).catch(() => undefined);
  return true;
}

/**
 * Restart recovery for chains: every running or stitching chain driven to the end, up to
 * {@link RECOVERY_CONCURRENCY} at a time, so one long recording does not hold the others back.
 */
export async function recoverChains(deps: RunDeps, log: (line: string) => void = () => undefined, concurrency = RECOVERY_CONCURRENCY): Promise<ChainStep[]> {
  // At startup no loop is driving anything yet; a second loop on one chain would only race safely.
  const queue = deps.store.chains.listActive();
  const steps: ChainStep[] = [];
  const worker = async () => {
    for (let chain = queue.shift(); chain; chain = queue.shift()) {
      try {
        const step = await runChainToCompletion(deps, chain.id);
        log(`[recovery] chain ${chain.id} (${chain.recipe.id}, ${chain.segments.length} segments): ${step.kind}`);
        steps.push(step);
      } catch (cause) {
        log(`[recovery] chain ${chain.id} (${chain.recipe.id}): stopped, ${toJobError(cause).code}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return steps;
}

/** The whole recording's reservation and where it stands, in one line for the proposal card and results. */
export function chainSummary(chain: Chain): string {
  const made = chain.segments.filter((segment) => segment.assetId).length;
  const reserved = chainReserveUsd(chain);
  const money = reserved > 0 ? `, $${reserved.toFixed(2)} reserved for the whole recording` : "";
  if (chain.status === "completed") return `Chained recording: ${chain.segments.length} segments stitched into ${chain.totalSeconds.toFixed(1)} s${money}.${chain.notice ? ` ${chain.notice}` : ""}`;
  if (isChainFinal(chain) || chain.status === "paused") return chain.notice ?? `Chained recording ${chain.status}.`;
  if (chain.status === "stitching") return `Chained recording: stitching ${chain.segments.length} segments${money}.`;
  return `Chained recording: segment ${Math.min(made + 1, chain.segments.length)} of ${chain.segments.length} in progress${money}.`;
}

/** A chain as the project state and the jobs poll report it. */
export function chainView(chain: Chain): ChainView {
  const made = chain.segments.filter((segment) => segment.assetId).length;
  const current = chain.segments.find((segment) => !segment.assetId);
  return {
    id: chain.id,
    status: chain.status,
    target: chain.target,
    recipeId: chain.recipe.id,
    totalSeconds: chain.totalSeconds,
    segmentCount: chain.segments.length,
    segmentsMade: made,
    currentSegment: current?.index ?? null,
    jobId: current?.jobId ?? null,
    reservedUsd: chainReserveUsd(chain),
    summary: chainSummary(chain).slice(0, 1200),
    notice: chain.notice,
    outputAssetId: chain.outputAssetId,
    updatedAt: chain.updatedAt,
  };
}
