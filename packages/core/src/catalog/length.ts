/**
 * Length as a capability (v0.2 F4): how a recipe makes a clip of a given length. A take no longer
 * than the recipe makes in one run is native; a longer one is either one whole-take community
 * workflow (where the backend runs custom graphs) or chained segments, each started from the
 * previous segment's handover frame and joined with a short crossfade.
 *
 * | Strategy | When | What runs |
 * | --- | --- | --- |
 * | `native` | the take fits one run (H3 multi-frame, H3 last frame, Kling first/last up to 15 s, LTX extension where a recipe declares it) | one job |
 * | `workflow` | the recipe is a whole-take workflow and the backend runs custom graphs | one job through the Workflow executor |
 * | `chained` | the recipe animates a first frame (or follows a voice take) | one durable job per segment, then a local stitch |
 *
 * One run's length is the recipe's known-good length (the workflow's default frame count, the
 * Router durations), with half a second of slack for workflows, which snap to their own length.
 * Recipes that cannot chain (an ending frame pins the run) keep making a longer beat in one run up
 * to {@link hardMaxSeconds}, as before chaining existed.
 *
 * Pure: no I/O. The orchestration lives in the app (`src/server/generation/chain.ts`).
 * @packageDocumentation
 */
import { z } from "zod";
import type { BackendKind } from "./backends";
import type { Recipe } from "./recipes";

/** How a recipe reaches its native length in one job. */
export const NativeLengthSchema = z.enum(["single_run", "h3_multiframe", "h3_last_frame", "kling_first_last", "ltx_extension"]);
export type NativeLength = z.infer<typeof NativeLengthSchema>;

/** Optional length facts on a recipe; everything else is derived from its limits and sidecar. */
export const RecipeLengthSchema = z
  .object({
    /** The longest clip one job makes, in seconds. Derived from the recipe's limits when absent. */
    nativeMaxSeconds: z.number().positive().max(60).optional(),
    /** The mechanism behind the native length, for the strategy table and the proposal note. */
    native: NativeLengthSchema.optional(),
    /**
     * How a longer take is made: `chain` (segments; the default for image to video and speech to
     * video), `workflow` (this recipe is one whole-take community workflow), or `none`.
     */
    longer: z.enum(["chain", "workflow", "none"]).optional(),
  })
  .strict();
export type RecipeLength = z.infer<typeof RecipeLengthSchema>;

/** What drives each chained segment: the previous segment's handover frame, or a slice of the voice take. */
export type ChainDrive = "first_frame" | "audio";

export const LENGTH_LABELS: Record<NativeLength, string> = {
  single_run: "one run",
  h3_multiframe: "H3 multi-frame",
  h3_last_frame: "H3 last frame",
  kling_first_last: "Kling first/last",
  ltx_extension: "LTX extension",
};

/** Mock video recipes behave like a five-second model. */
export const MOCK_NATIVE_SECONDS = 5;
/** The longest take a chain plans (thirteen segments of about five seconds). */
export const MAX_TAKE_SECONDS = 60;
export const MAX_CHAIN_SEGMENTS = 13;
/** The crossfade a seam aims for (the v0.2 spike's 0.25 s) and the least it uses (two frames at 24 fps). */
export const TARGET_OVERLAP_SECONDS = 0.25;
export const MIN_OVERLAP_SECONDS = 2 / 24;
/** How far a planned take may fall short of the request before another segment is added. */
export const LENGTH_TOLERANCE_SECONDS = 0.5;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Frames per second a recipe renders at, when it says. */
export function recipeFps(recipe: Recipe): number | undefined {
  if (recipe.kind === "workflow") return recipe.sidecar.limits.fps ?? recipe.limits.fps;
  return recipe.limits.fps;
}

/**
 * The longest clip one job of this recipe makes: the declared `length.nativeMaxSeconds`, else the
 * Router durations' maximum, else the workflow's frame limit (or its known-good default length) over
 * its frame rate, else five seconds for a mock. Undefined for recipes without a length.
 */
export function nativeMaxSeconds(recipe: Recipe): number | undefined {
  if (recipe.length?.nativeMaxSeconds) return recipe.length.nativeMaxSeconds;
  if (recipe.kind === "router") {
    const durations = recipe.limits.durations;
    if (durations?.length) return Math.max(...durations);
    return recipe.defaults.durationSeconds;
  }
  if (recipe.kind === "workflow") {
    const limits = recipe.sidecar.limits.length;
    const frames = limits?.max ?? recipe.defaults.length ?? limits?.default;
    const fps = recipeFps(recipe);
    return frames && fps ? round3(frames / fps) : undefined;
  }
  return isVideoCapability(recipe.capability) ? MOCK_NATIVE_SECONDS : undefined;
}

/**
 * The most one run accepts at all, past the known-good length: a declared frame limit, the Router
 * durations, else the 15 s a beat can last. Used only for recipes that cannot chain (an ending
 * frame pins one run), which keep making a longer beat in one run as before.
 */
export function hardMaxSeconds(recipe: Recipe): number | undefined {
  const known = nativeMaxSeconds(recipe);
  if (known === undefined) return undefined;
  if (recipe.kind === "router" && recipe.limits.durations?.length) return known;
  if (recipe.kind === "workflow" && recipe.sidecar.limits.length?.max) return known;
  return Math.max(known, 15);
}

function isVideoCapability(capability: Recipe["capability"]): boolean {
  return capability.endsWith("_to_video");
}

/** What drives a chain for this recipe, or undefined when it cannot be chained. */
export function chainDrive(recipe: Recipe): ChainDrive | undefined {
  if (recipe.length?.longer === "none" || recipe.length?.longer === "workflow") return undefined;
  if (recipe.capability === "image_to_video") return "first_frame";
  if (recipe.capability === "speech_to_video") return "audio";
  return undefined;
}

/**
 * Whether a backend runs custom (community) graphs: Comfy Cloud and a self-hosted ComfyUI do; a Comfy
 * API deployment runs the graphs it was deployed with, and Router runs no graphs.
 */
export function backendAllowsCustomGraphs(kind: BackendKind | undefined): boolean {
  return kind === undefined || kind === "cloud" || kind === "comfyui";
}

/** One planned segment of a chained take, in take time. */
export interface PlannedSegment {
  /** 1-based. */
  index: number;
  /** Where this segment starts in the take (the previous one's crossfade start). */
  startSeconds: number;
  durationSeconds: number;
}

export interface ChainPlan {
  /** What the stitched take will last: the segments minus the crossfades. */
  totalSeconds: number;
  /** The crossfade at every seam; segment k+1 starts from segment k's frame at its length minus this. */
  overlapSeconds: number;
  segments: PlannedSegment[];
}

/**
 * Plans the fewest segments of at most `segmentMaxSeconds` that cover `totalSeconds` with a short
 * crossfade at every seam. The crossfade comes out of the segments' spare length: it aims for
 * {@link TARGET_OVERLAP_SECONDS}, never under {@link MIN_OVERLAP_SECONDS}, and when the model has
 * no spare length the take may come out up to {@link LENGTH_TOLERANCE_SECONDS} short instead of
 * paying for another segment (20 s on a 5 s model is four segments, 19.75 s).
 */
export function planChain(totalSeconds: number, segmentMaxSeconds: number): ChainPlan {
  if (!(segmentMaxSeconds > MIN_OVERLAP_SECONDS * 2)) throw new Error("A chain needs segments longer than its crossfade.");
  let count = Math.max(2, Math.ceil(totalSeconds / segmentMaxSeconds));
  const reach = (n: number) => n * segmentMaxSeconds - (n - 1) * MIN_OVERLAP_SECONDS;
  while (reach(count) < totalSeconds - LENGTH_TOLERANCE_SECONDS) count += 1;
  if (count > MAX_CHAIN_SEGMENTS) throw new Error(`A take of ${totalSeconds} s needs more than ${MAX_CHAIN_SEGMENTS} segments.`);
  const spare = (count * segmentMaxSeconds - totalSeconds) / (count - 1);
  const overlap = round3(Math.min(TARGET_OVERLAP_SECONDS, Math.max(MIN_OVERLAP_SECONDS, spare)));
  const length = round3(Math.min(segmentMaxSeconds, (totalSeconds + (count - 1) * overlap) / count));
  const segments = Array.from({ length: count }, (_, position) => ({
    index: position + 1,
    startSeconds: round3(position * (length - overlap)),
    durationSeconds: length,
  }));
  return { totalSeconds: Math.round((count * length - (count - 1) * overlap) * 100) / 100, overlapSeconds: overlap, segments };
}

export type LengthStrategy =
  | { kind: "native"; mechanism: NativeLength; maxSeconds: number }
  | { kind: "workflow"; maxSeconds: number }
  | { kind: "chained"; drive: ChainDrive; segmentMaxSeconds: number; plan: ChainPlan }
  | { kind: "unsupported"; reason: string };

/**
 * Resolves how a recipe makes a take of `seconds`. `customGraphs` says whether the backend the
 * recipe is placed on runs custom graphs (see {@link backendAllowsCustomGraphs}).
 */
export function resolveLengthStrategy(recipe: Recipe, seconds: number, options: { customGraphs?: boolean } = {}): LengthStrategy {
  const max = nativeMaxSeconds(recipe);
  if (max === undefined) return { kind: "unsupported", reason: `${recipe.title} does not make video of a set length.` };
  // A workflow (or the mock) snaps a slightly longer request to its own length, so half a second
  // over is still one run rather than a second paid segment; Router durations are exact.
  const slack = recipe.kind === "router" ? 0.01 : LENGTH_TOLERANCE_SECONDS;
  if (seconds <= max + slack) return { kind: "native", mechanism: recipe.length?.native ?? "single_run", maxSeconds: max };
  if (seconds > MAX_TAKE_SECONDS) return { kind: "unsupported", reason: `Takes are at most ${MAX_TAKE_SECONDS} s.` };
  if (recipe.length?.longer === "workflow" && recipe.kind === "workflow") {
    if (options.customGraphs ?? true) return { kind: "workflow", maxSeconds: max };
    return { kind: "unsupported", reason: `${recipe.title} is a whole-take workflow, and this backend runs only the graphs it was deployed with. Run it on Comfy Cloud or a self-hosted ComfyUI.` };
  }
  const drive = chainDrive(recipe);
  if (!drive) {
    // An ending frame (or a recipe that cannot start from another run's frame) keeps one run, as
    // long as the model accepts that length; past its known-good length it is unverified.
    const hard = hardMaxSeconds(recipe) ?? max;
    if (seconds <= hard + 0.01) return { kind: "native", mechanism: recipe.length?.native ?? "single_run", maxSeconds: hard };
    const what = recipe.capability === "first_last_to_video" ? "An ending frame pins the end of one run" : `${recipe.title} cannot start a run from another run's last frame`;
    return { kind: "unsupported", reason: `${what}, so it makes at most ${hard} s. Use an image to video recipe for a longer take, or shorten it.` };
  }
  return { kind: "chained", drive, segmentMaxSeconds: max, plan: planChain(seconds, max) };
}

/** Where every seam sits in the stitched take: the middle of each crossfade. */
export function seamTimes(plan: Pick<ChainPlan, "overlapSeconds"> & { segments: { durationSeconds: number }[] }): number[] {
  const seams: number[] = [];
  let offset = 0;
  for (let index = 0; index < plan.segments.length - 1; index++) {
    offset += plan.segments[index].durationSeconds - plan.overlapSeconds;
    seams.push(round3(offset + plan.overlapSeconds / 2));
  }
  return seams;
}
