/**
 * The Chain step in the tools layer: whether a clip proposal is made in one run or as a chained
 * recording, decided per recipe by `resolveLengthStrategy` (native, a whole-recording workflow, or chained
 * segments), and what a chained candidate needs (segment prompts with continuity, the starting
 * still, an identity reference where the recipe takes one, and the voice recording as the audio spine).
 * `buildProposal` and `submit_proposal` both ask here, so the card, the price, and what runs agree.
 * @packageDocumentation
 */
import {
  type ChainPlan,
  LENGTH_LABELS,
  type LengthStrategy,
  type Recipe,
  backendAllowsCustomGraphs,
  imageSlotNames,
  resolveLengthStrategy,
} from "@creator-lab/core/catalog";
import type { Asset } from "@creator-lab/core/domain/asset";
import { fail } from "@creator-lab/core/domain/failure";
import type { EstimateSummary, GenerationInput, GenerationTarget } from "@creator-lab/core/domain/job";
import type { ClipSpec, ShotSpec, TakeSpec } from "@creator-lab/core/domain/shot-spec";
import type { EstimateOutcome } from "@creator-lab/executors";
import { type ChainSegmentPrompt, renderChain } from "@creator-lab/recipes/chain";
import { serverPlugins } from "@/plugins/server";
import type { ToolContext } from "@/server/tools/registry";
import { requireGeneration } from "@/server/tools/registry";

/** A clip proposal made as a chained recording. */
export interface ChainedTake {
  strategy: Extract<LengthStrategy, { kind: "chained" }>;
  plan: ChainPlan;
  prompts: ChainSegmentPrompt[];
  /** The first frame of segment 1. */
  still: Asset;
  /** An identity reference passed beside each segment's start frame, when the recipe takes two images. */
  identity: Asset | null;
  /** The voice recording that is the clip's one audio track (and what speech-driven segments follow). */
  spine: Asset | null;
}

/** How many images one run of a recipe takes at most. */
function maxImages(recipe: Recipe): number {
  if (recipe.kind === "workflow") return imageSlotNames(recipe.sidecar).length;
  if (recipe.kind === "router") return recipe.fieldMap.images?.max ?? 0;
  return recipe.limits.maxReferences ?? 16;
}

/** Whether the backend a recipe is bound to runs custom graphs (Cloud and self-hosted ComfyUI). */
function customGraphs(context: ToolContext, recipe: Recipe): boolean {
  if (recipe.kind !== "workflow" || !recipe.backendId) return true;
  const backend = requireGeneration(context).routing?.().backends.find((entry) => entry.id === recipe.backendId);
  return backendAllowsCustomGraphs(backend?.kind);
}

/** The approved voice recording of a shot's beat, when the target is a shot and one is approved. */
function approvedVoice(context: ToolContext, target: GenerationTarget): Asset | null {
  if (target.kind !== "shot") return null;
  const shot = context.store.content.get(target.contentId)?.shots.find((entry) => entry.beatIndex === target.beatIndex);
  if (!shot || shot.voice.state !== "approved") return null;
  const asset = context.store.assets.get(shot.voice.assetId);
  return asset && asset.kind === "audio" && asset.audio && asset.state.state === "active" ? asset : null;
}

/** The project's character as an identity reference: the approved sheet, else the locked face. */
function identityReference(context: ToolContext, projectId: string): Asset | null {
  for (const link of context.store.library.listLinks(projectId)) {
    if (link.kind !== "character") continue;
    const item = context.store.library.get(link.itemId);
    if (!item || item.kind !== "character" || item.archived) continue;
    const id = link.sheetAssetId ?? item.bible.references.faceAssetId;
    const asset = id ? context.store.assets.get(id) : undefined;
    if (asset && asset.state.state === "active") return asset;
  }
  return null;
}

/**
 * An Ad's full talking recording (recording with cutaways) as one long talking clip spec, so it is
 * chained like any long clip: every beat's line in order is the line shared out across segments,
 * the opening beat's visual and setting are the picture. The spec is not re-parsed as a whole (a
 * recording runs past a beat's 15 s); each segment's share is checked by `renderChain` as usual.
 */
export function takeAsClip(spec: TakeSpec): ClipSpec {
  return {
    kind: "clip",
    mode: "start",
    durationSeconds: spec.durationSeconds,
    beat: {
      index: spec.lines[0]?.beatIndex ?? 1,
      type: "talking",
      purpose: "hook",
      spokenLine: spec.lines.map((line) => line.text.trim()).join(" "),
      onScreenText: "",
      visual: spec.visual,
      setting: spec.setting,
      productVisible: spec.product !== undefined,
      durationSeconds: Math.min(15, spec.durationSeconds),
      notes: "",
    },
    ...(spec.character ? { character: spec.character } : {}),
    ...(spec.product ? { product: spec.product } : {}),
  };
}

/** The clip spec a chained recording splits: a clip's own, or a talking recording's as one clip. */
function chainableSpec(shot: ShotSpec): ClipSpec | undefined {
  if (shot.kind === "clip") return shot;
  if (shot.kind === "take") return takeAsClip(shot);
  return undefined;
}

/**
 * Refuses a video proposal longer than one run of its recipe that is not a clip or talking-recording
 * spec (a hand-written prompt through propose_candidates): only those know the line to split into segments.
 */
export function assertOneRunLength(context: ToolContext, recipe: Recipe, shot: ShotSpec, durationSeconds: number | undefined): void {
  if (shot.kind === "clip" || shot.kind === "take" || durationSeconds === undefined || !recipe.capability.endsWith("_to_video")) return;
  const strategy = resolveLengthStrategy(recipe, durationSeconds, { customGraphs: customGraphs(context, recipe) });
  if (strategy.kind === "unsupported") fail("invalid", strategy.reason);
  if (strategy.kind === "chained") {
    fail("invalid", `${recipe.title} makes at most ${strategy.segmentMaxSeconds} s in one run. For a longer clip of a beat, use generate_clip with durationSeconds: it is made as a chained recording.`);
  }
}

/**
 * The chained recording for a clip proposal, or undefined when one run makes it (native, or a
 * whole-recording workflow). Refuses, with the reason, a length the recipe cannot reach.
 */
export function chainedTake(
  context: ToolContext,
  args: { projectId: string; recipe: Recipe; shot: ShotSpec; durationSeconds: number | undefined; target: GenerationTarget; assets: Asset[] },
): ChainedTake | undefined {
  const spec = chainableSpec(args.shot);
  if (!spec) return undefined;
  const seconds = args.durationSeconds ?? spec.durationSeconds;
  const strategy = resolveLengthStrategy(args.recipe, seconds, { customGraphs: customGraphs(context, args.recipe) });
  if (strategy.kind === "unsupported") fail("invalid", args.shot.kind === "take" ? `${strategy.reason} This talking recording is ${seconds} s.` : strategy.reason);
  if (strategy.kind !== "chained") return undefined;
  // The mock always makes a real recording for a talking-recording target, so it chains without MOCK_VIDEO.
  if (args.recipe.kind === "mock" && args.target.kind !== "take" && requireGeneration(context).executors.mock.video !== "mp4") {
    fail("invalid", "A chained recording hands frames from one segment to the next, and the mock makes storyboards. Start the app with MOCK_VIDEO=mp4 for real mock clips, or shorten the clip.");
  }
  const still = args.assets.find((asset) => asset.kind !== "audio") ?? fail("invalid", "A chained recording starts from the beat's approved still.");
  const voiceReference = args.assets.find((asset) => asset.kind === "audio") ?? null;
  // Speech to video follows the recording it was given; image to video uses the beat's approved voice-over as its audio.
  const spine = spec.mode === "speech" ? voiceReference : spec.beat.type === "talking" ? approvedVoice(context, args.target) : null;
  if (strategy.drive === "audio" && !spine) fail("invalid", "A speech to video clip follows a voice recording; approve one for this beat first.");
  if (spine?.audio && spine.audio.durationSeconds > strategy.plan.totalSeconds + 0.05) {
    fail("invalid", `The beat's voice recording lasts ${spine.audio.durationSeconds.toFixed(1)} s; a ${strategy.plan.totalSeconds.toFixed(1)} s clip would cut it. Make the clip at least ${Math.ceil(spine.audio.durationSeconds + 0.4)} s.`);
  }
  const identity = maxImages(args.recipe) >= 2 && spec.beat.type === "talking" ? identityReference(context, args.projectId) : null;
  const rendered = renderChain(spec, strategy.plan, args.recipe, serverPlugins.renderers());
  if (!rendered.ok) fail("invalid", rendered.error);
  return { strategy, plan: strategy.plan, prompts: rendered.segments, still, identity: identity && identity.id !== still.id ? identity : null, spine };
}

/** The input segment `index` would run with, for pricing before anything is written. */
export function pricingInput(take: ChainedTake, index: number, base: Pick<GenerationInput, "aspectRatio" | "seed" | "slots">): GenerationInput {
  const segment = take.plan.segments[index];
  return {
    prompt: take.prompts[index].prompt,
    images: [take.still.relativePath, ...(take.identity ? [take.identity.relativePath] : [])],
    ...(take.strategy.drive === "audio" && take.spine ? { audio: take.spine.relativePath } : {}),
    ...(base.aspectRatio ? { aspectRatio: base.aspectRatio } : {}),
    durationSeconds: segment.durationSeconds,
    ...(base.slots && Object.keys(base.slots).length ? { slots: base.slots } : {}),
    ...(base.seed !== undefined ? { seed: base.seed } : {}),
  };
}

/** One estimate for the whole recording: every segment priced by the executor and added up. */
export function combineEstimates(take: ChainedTake, recipe: Recipe, estimates: EstimateOutcome[]): EstimateSummary {
  const { plan } = take;
  const span = `${plan.segments.length} segments of ${plan.segments[0].durationSeconds.toFixed(2)} s with ${plan.overlapSeconds.toFixed(2)} s crossfades, ${plan.totalSeconds.toFixed(2)} s in all`;
  const audio = take.spine ? ", the beat's approved voice recording as the one audio track" : ", each segment's own sound crossfaded at the seams";
  // A voice recording shorter than the clip leaves its end without a voice; the card says so.
  const quiet = take.spine?.audio && take.spine.audio.durationSeconds < plan.totalSeconds - 0.5 ? ` The voice recording runs ${take.spine.audio.durationSeconds.toFixed(1)} s, so the last ${(plan.totalSeconds - take.spine.audio.durationSeconds).toFixed(1)} s have no voice.` : "";
  const head = `Chained recording: ${span}, each segment started from the one before${audio}.${quiet} The whole recording is reserved before segment 1 starts.`;
  const rejected = estimates.find((estimate) => estimate.kind === "rejected");
  if (rejected && rejected.kind === "rejected") return { kind: "rejected", usd: null, credits: null, note: `${head} ${rejected.error.message}`.slice(0, 600) };
  if (estimates.every((estimate) => estimate.kind === "free")) return { kind: "free", usd: 0, credits: 0, note: `${head} ${estimates[0].kind === "free" ? estimates[0].note : ""}`.trim().slice(0, 600) };
  const usd = (estimate: EstimateOutcome) => (estimate.kind === "quoted" ? estimate.usd : estimate.kind === "unquoted" ? (estimate.ceilingUsd ?? recipe.ceilingUsd ?? null) : 0);
  const amounts = estimates.map(usd);
  const total = amounts.some((amount) => amount === null) ? null : Math.round(amounts.reduce((sum: number, amount) => sum + (amount ?? 0), 0) * 1e6) / 1e6;
  const money = total === null ? "" : ` $${total.toFixed(2)} for the recording.`;
  const unquoted = estimates.find((estimate) => estimate.kind === "unquoted");
  if (unquoted && unquoted.kind === "unquoted") return { kind: "unquoted", usd: total, credits: null, note: `${head}${money} ${unquoted.note}`.slice(0, 600) };
  const quoted = estimates.filter((estimate) => estimate.kind === "quoted");
  const credits = quoted.reduce((sum, estimate) => sum + (estimate.kind === "quoted" ? estimate.credits : 0), 0);
  const live = quoted.every((estimate) => estimate.kind === "quoted" && estimate.source === "live");
  const first = quoted[0];
  return { kind: "quoted", usd: total ?? 0, credits, source: live ? "live" : "hint", note: `${head}${money} ${first && first.kind === "quoted" ? first.note : ""}`.trim().slice(0, 600) };
}

/** The strategy in a few words, for notes and the docs table. */
export function strategyLabel(strategy: LengthStrategy): string {
  if (strategy.kind === "native") return `native (${LENGTH_LABELS[strategy.mechanism]}, up to ${strategy.maxSeconds} s)`;
  if (strategy.kind === "workflow") return "one whole-recording workflow";
  if (strategy.kind === "chained") return `chained (${strategy.plan.segments.length} segments, ${strategy.drive === "audio" ? "each following its slice of the voice recording" : "each from the previous last frame"})`;
  return "unsupported";
}
