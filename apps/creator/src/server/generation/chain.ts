/**
 * Chained takes (v0.2 F4): a take longer than its recipe makes in one run, made as segments. Each
 * segment is an ordinary durable job (admitted, submitted, polled, retrieved, and committed by
 * `run.ts`, with uncertain-submission recovery and the one automatic retry after a black output),
 * started from the previous segment's handover frame (or, for speech to video, its slice of the
 * voice take). The chain record (`store.chains`) says which job made which segment, so a restart
 * resumes exactly where it stopped. When every segment is in, they are stitched locally with a short
 * crossfade at each seam (the voice take as the one audio track when the beat has one), the seams
 * are checked, and the stitched take lands where the proposal aimed it, as one candidate.
 *
 * Budget: admitting a chain reserves every segment at once. The whole take must fit this period's
 * remaining budget before segment 1 runs, and segments not admitted yet stay held (`chainHoldUsd`),
 * so later spending cannot strand a half-paid take. A segment that still cannot be admitted (the
 * operator ceiling was lowered, a live price rose) pauses the chain with a notice and releases its
 * hold; submitting the proposal again re-checks the rest as a whole and resumes it.
 * @packageDocumentation
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ChainDrive, ChainPlan, Recipe } from "@creator-lab/core/catalog";
import { type Asset, AssetSchema, archiveAsset } from "@creator-lab/core/domain/asset";
import type { GenerationInput, GenerationTarget, Job, JobError, JobInput } from "@creator-lab/core/domain/job";
import type { ShotSpec } from "@creator-lab/core/domain/shot-spec";
import { type BudgetCrossing, budgetCrossing, describeCrossing } from "@creator-lab/core/domain/spend";
import { PAID_GENERATION_OFF, reservationUsd } from "@creator-lab/executors/allowance";
import { type Chain, type ChainSegment, chainReserveUsd, isChainFinal, updateChain, withSegment } from "@creator-lab/executors/chain";
import { jobError, toJobError } from "@creator-lab/executors/jobs";
import { currentSpendPolicy } from "@creator-lab/executors/spend";
import { SEAM_ISSUE_TEXT, type SeamReport, checkSeams, extractHandoverFrame, sliceAudio, stitchTake } from "@creator-lab/executors/stitch";
import { attachToTarget } from "@/server/media/commit";
import { removeMedia } from "@/server/media/files";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import { extractPoster } from "@/server/media/video";
import { type RunDeps, UNCERTAIN_EXPIRED_NOTICE, advanceGeneration, retryRequestId, startGeneration } from "@/server/generation/run";

/** What a proposal candidate turns into when its take is chained. */
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
  /** The continuous voice take: the take's audio, and for speech to video what each segment follows. */
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

const clock = (deps: RunDeps) => (deps.now ?? Date.now)();

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

function failChain(deps: RunDeps, chain: Chain, error: JobError, notice: string): ChainStep {
  const saved = save(deps, chain, { status: "failed", error, notice: notice.slice(0, 600) });
  return { kind: "failed", chain: saved, error };
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

/** The whole take checked against this period's remaining budget; null when it fits. */
function budgetBlock(deps: RunDeps, totalUsd: number): Extract<ChainStart, { kind: "blocked" }> | null {
  if (totalUsd <= 0) return null;
  const policy = currentSpendPolicy(deps);
  if (policy.ceilingUsd <= 0) return { kind: "blocked", error: jobError("budget", PAID_GENERATION_OFF) };
  const crossing = budgetCrossing(policy, totalUsd);
  return crossing ? { kind: "blocked", error: jobError("budget", `The whole take is reserved before segment 1 runs. ${describeCrossing(crossing)}`), budget: crossing } : null;
}

/**
 * Admits a chained candidate: prices every segment, refuses the whole take when it would cross the
 * remaining budget (nothing runs), saves the chain with every segment held, and starts segment 1.
 * A repeat returns the saved chain; a paused one is re-checked and resumed.
 */
export async function startChain(deps: RunDeps, request: NewChain, options: { confirmUnquoted?: boolean } = {}): Promise<ChainStart> {
  const existing = deps.store.chains.getByRequest(request.requestId);
  if (existing) {
    if (existing.projectId !== request.projectId) return { kind: "failed", chain: null, error: jobError("conflict", "This request id was already used for a different take.") };
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
    return { kind: "needs_confirmation", reserveUsd: totalUsd, reason: `${priced.unquoted} Up to $${totalUsd.toFixed(2)} will be reserved for the ${segments.length} segments of this take.` };
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
  const resumed = save(deps, chain, { status: "running", notice: null });
  const step = await advanceChain(deps, resumed.id);
  if (step.kind === "failed") return { kind: "failed", chain: step.chain, error: step.error };
  return { kind: "started", chain: step.chain, job: currentJob(deps, step.chain) };
}

/** The job of the segment in progress (or the last one), for the submit result. */
export function currentJob(deps: RunDeps, chain: Chain): Job | null {
  const segment = chain.segments.find((entry) => !entry.assetId) ?? chain.segments[chain.segments.length - 1];
  return segment.jobId ? (deps.store.jobs.get(segment.jobId) ?? null) : null;
}

async function writtenRef(deps: RunDeps, relativePath: string): Promise<{ relativePath: string; sha256: string }> {
  return { relativePath, sha256: sha256(await readFile(resolveMediaPath(deps.store.dataDir, relativePath))) };
}

/** Writes what a segment starts from: the previous segment's handover frame, and its slice of the voice take. */
async function prepareSegment(deps: RunDeps, chain: Chain, segment: ChainSegment): Promise<Chain> {
  let current = chain;
  if (segment.index > 1 && !segment.startFrame) {
    const previous = current.segments[segment.index - 2];
    const asset = deps.store.assets.getRequired(previous.assetId!);
    const relativePath = `media/${chain.id}-segment-${segment.index}-start.png`;
    await extractHandoverFrame(resolveMediaPath(deps.store.dataDir, asset.relativePath), { frames: asset.video!.frameCount, fps: asset.video!.frameRate }, chain.overlapSeconds, resolveMediaPath(deps.store.dataDir, relativePath));
    current = save(deps, current, { segments: withSegment(current, segment.index, { startFrame: await writtenRef(deps, relativePath) }) });
  }
  const fresh = current.segments[segment.index - 1];
  if (current.drive === "audio" && current.spine && !fresh.audio) {
    const relativePath = `media/${chain.id}-segment-${segment.index}-voice.wav`;
    await sliceAudio(resolveMediaPath(deps.store.dataDir, current.spine.relativePath), fresh.startSeconds, fresh.durationSeconds, resolveMediaPath(deps.store.dataDir, relativePath));
    current = save(deps, current, { segments: withSegment(current, segment.index, { audio: await writtenRef(deps, relativePath) }) });
  }
  return current;
}

/** Admits the next segment's job against the hold kept for it; pauses the chain when it cannot be admitted. */
async function admitSegment(deps: RunDeps, chain: Chain, segment: ChainSegment): Promise<ChainStep | Chain> {
  const prepared = await prepareSegment(deps, chain, segment);
  const ready = prepared.segments[segment.index - 1];
  // Segment jobs after the first start from a frame that is not an asset, so only the first pins its still.
  const inputs = segment.index === 1 ? prepared.inputs.slice(0, prepared.images.length) : [];
  const outcome = await startGeneration(
    deps,
    { requestId: ready.requestId, projectId: prepared.projectId, recipe: prepared.recipe, input: segmentInput(prepared, ready), inputs, target: prepared.target, spec: prepared.spec },
    // The person accepted the whole take's reservation when the chain was admitted.
    { confirmUnquoted: true, heldUsd: ready.reserveUsd },
  );
  if (outcome.kind === "blocked" || outcome.kind === "needs_confirmation") {
    const why = outcome.kind === "blocked" ? outcome.error.message : outcome.reason;
    const done = prepared.segments.filter((entry) => entry.assetId).length;
    const notice = `Paused before segment ${segment.index} of ${prepared.segments.length} (${done} made and kept): ${why} Submit the proposal again to resume; the rest of the take is checked against the budget as a whole.`;
    return { kind: "paused", chain: save(deps, prepared, { status: "paused", notice: notice.slice(0, 600) }) };
  }
  if (outcome.kind === "failed" && !outcome.job) {
    return failChain(deps, prepared, outcome.error, `Segment ${segment.index} of ${prepared.segments.length} could not be started: ${outcome.error.message}`);
  }
  const job = outcome.kind === "failed" ? outcome.job! : outcome.job;
  return save(deps, prepared, { segments: withSegment(prepared, segment.index, { jobId: job.id }) });
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
    if (chain.status === "failed") return { kind: "failed", chain, error: chain.error ?? jobError("provider", "This take failed.") };
    if (chain.status === "paused") return { kind: "paused", chain };
    if (chain.status === "stitching") return stitchChain(deps, chain);
    const segment = chain.segments.find((entry) => !entry.assetId);
    if (!segment) {
      save(deps, chain, { status: "stitching" });
      continue;
    }
    if (!segment.jobId) {
      // A crash between admitting the job and recording it leaves the job findable by its request id.
      const admitted = deps.store.jobs.getByRequest(segment.requestId);
      if (admitted) {
        save(deps, chain, { segments: withSegment(chain, segment.index, { jobId: admitted.id }) });
        continue;
      }
      const admittedStep = await admitSegment(deps, chain, segment);
      if ("kind" in admittedStep) return admittedStep;
      continue;
    }
    const job = deps.store.jobs.getRequired(segment.jobId);
    const label = `Segment ${segment.index} of ${chain.segments.length}`;
    if (job.status === "completed") {
      const asset = deps.store.assets.get(job.outputs[0]);
      if (!asset || asset.mime !== "video/mp4" || !asset.video) {
        return failChain(deps, chain, jobError("invalid", "A chained take needs real video segments."), `${label} came back as a ${asset?.kind ?? "missing"} file, not a video, so it cannot be handed over or stitched. The mock makes storyboards unless MOCK_VIDEO=mp4 is set.`);
      }
      save(deps, chain, { segments: withSegment(chain, segment.index, { assetId: asset.id }) });
      continue;
    }
    if (job.status === "failed") {
      const retry = deps.store.jobs.getByRequest(segment.retryRequestId);
      if (retry && retry.id !== job.id) {
        save(deps, chain, { segments: withSegment(chain, segment.index, { jobId: retry.id }) });
        continue;
      }
      const step = await advanceGeneration(deps, job.id);
      if (step.kind === "failed" && step.retry) {
        save(deps, chain, { segments: withSegment(chain, segment.index, { jobId: step.retry.id }) });
        continue;
      }
      const made = chain.segments.filter((entry) => entry.assetId).length;
      return failChain(deps, chain, job.error, `${label} failed: ${job.error.message} The ${made} segment${made === 1 ? "" : "s"} already made are kept in the Archive; the rest of the take was not started and its reservation is released.`);
    }
    let step;
    try {
      step = await advanceGeneration(deps, job.id);
    } catch (cause) {
      return { kind: "waiting", chain, job, retryAfterMs: toJobError(cause).retryable ? 5000 : 60_000 };
    }
    if (step.kind === "waiting") {
      if (step.uncertain && step.job.notice === UNCERTAIN_EXPIRED_NOTICE) {
        return failChain(deps, chain, jobError("provider", UNCERTAIN_EXPIRED_NOTICE), `${label} could not be confirmed within 23 hours, so the take stops here and its remaining reservation is released. Check your Comfy usage before generating again.`);
      }
      return { kind: "waiting", chain, job: step.job, retryAfterMs: step.retryAfterMs };
    }
  }
  return { kind: "waiting", chain: deps.store.chains.getRequired(chainId), job: null, retryAfterMs: 1000 };
}

function seamNotice(seams: SeamReport[]): string | null {
  const flagged = seams.filter((seam) => seam.issues.length);
  if (!flagged.length) return null;
  const parts = flagged.map((seam) => `${seam.issues.map((issue) => SEAM_ISSUE_TEXT[issue]).join(" and ")} at ${seam.seconds.toFixed(1)} s`);
  return `Seam check: ${parts.join("; ")}. Look at those moments before approving; a new take regenerates every segment.`.slice(0, 600);
}

/** Stitches every segment, checks the seams, and commits the take as one candidate where the proposal aimed it. */
async function stitchChain(deps: RunDeps, chain: Chain): Promise<ChainStep> {
  const segments = chain.segments.map((segment) => deps.store.assets.getRequired(segment.assetId!));
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
    // The stitch is local and free; a failure leaves the chain stitching so the next step tries again.
    return { kind: "waiting", chain, job: null, retryAfterMs: toJobError(cause).retryable ? 5000 : 30_000 };
  }
  let poster: string | undefined = posterPath;
  try {
    await (deps.poster ?? extractPoster)(absolute, resolveMediaPath(deps.store.dataDir, posterPath));
  } catch {
    poster = undefined;
  }
  const now = clock(deps);
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
      // Segment 1's job carries the take's shot spec and destination, so "Regenerate with..." finds them.
      jobId: chain.segments[0].jobId!,
      prompt: chain.segments.map((segment) => `[Segment ${segment.index}] ${segment.prompt}`).join("\n\n").slice(0, 8000),
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
  const notice = seamNotice(seams);
  const committed = deps.store.transaction(() => {
    const current = deps.store.chains.getRequired(chain.id);
    if (current.status !== "stitching" || current.revision !== chain.revision) return false;
    deps.store.assets.insert(asset);
    attachToTarget(deps.store, chain.target, [asset.id], now);
    for (const segment of segments) {
      const stored = deps.store.assets.get(segment.id);
      if (stored?.state.state === "active") deps.store.assets.update(archiveAsset(stored, `Segment of a chained take, stitched into ${asset.id.slice(0, 8)}`, now));
    }
    if (!deps.store.chains.update(updateChain(current, { status: "completed", outputAssetId: asset.id, seams, notice }, now))) throw new Error("The chain moved on while it was being stitched.");
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
  while (true) {
    const step = await advanceChain(deps, chainId);
    if (step.kind !== "waiting" || clock(deps) + step.retryAfterMs > deadline) return step;
    await sleep(step.retryAfterMs);
  }
}

/** Restart recovery for chains: every running or stitching chain, one at a time, driven to the end. */
export async function recoverChains(deps: RunDeps, log: (line: string) => void = () => undefined): Promise<ChainStep[]> {
  const steps: ChainStep[] = [];
  for (const chain of deps.store.chains.listActive()) {
    try {
      const step = await runChainToCompletion(deps, chain.id);
      log(`[recovery] chain ${chain.id} (${chain.recipe.id}, ${chain.segments.length} segments): ${step.kind}`);
      steps.push(step);
    } catch (cause) {
      log(`[recovery] chain ${chain.id} (${chain.recipe.id}): stopped, ${toJobError(cause).code}`);
    }
  }
  return steps;
}

/** The whole take's reservation and where it stands, in one line for the proposal card and results. */
export function chainSummary(chain: Chain): string {
  const made = chain.segments.filter((segment) => segment.assetId).length;
  const reserved = chainReserveUsd(chain);
  const money = reserved > 0 ? `, $${reserved.toFixed(2)} reserved for the whole take` : "";
  if (chain.status === "completed") return `Chained take: ${chain.segments.length} segments stitched into ${chain.totalSeconds.toFixed(1)} s${money}.${chain.notice ? ` ${chain.notice}` : ""}`;
  if (isChainFinal(chain) || chain.status === "paused") return chain.notice ?? `Chained take ${chain.status}.`;
  return `Chained take: segment ${Math.min(made + 1, chain.segments.length)} of ${chain.segments.length} in progress${money}.`;
}
