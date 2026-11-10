/**
 * Length as a capability (v0.2 F4): how a recipe makes a clip of a given length. A clip no longer
 * than the recipe makes in one run is native; a longer one is either one whole-recording community
 * workflow (where the backend runs custom graphs) or a chained recording: segments, each started
 * from the previous segment's handover frame and joined with a short crossfade.
 *
 * | Strategy | When | What runs |
 * | --- | --- | --- |
 * | `native` | the clip fits one run (H3 multi-frame, H3 last frame, Kling first/last up to 15 s; `ltx_extension` is named for a future LTX extend recipe, none exists yet) | one job |
 * | `workflow` | the recipe is a whole-recording workflow and the backend runs custom graphs | one job through the Workflow executor |
 * | `chained` | the recipe animates a first frame (or follows a voice recording) | one durable job per segment, then a local stitch |
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
     * How a longer clip is made: `chain` (segments; the default for image to video and speech to
     * video), `workflow` (this recipe is one whole-recording community workflow), or `none`.
     */
    longer: z.enum(["chain", "workflow", "none"]).optional(),
  })
  .strict();
export type RecipeLength = z.infer<typeof RecipeLengthSchema>;

/** What drives each chained segment: the previous segment's handover frame, or a slice of the voice recording. */
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
/** The longest recording a chain plans (thirteen segments of about five seconds). */
export const MAX_TAKE_SECONDS = 60;
export const MAX_CHAIN_SEGMENTS = 13;
/** The crossfade a seam aims for (the v0.2 spike's 0.25 s) and the least it uses (two frames at 24 fps). */
export const TARGET_OVERLAP_SECONDS = 0.25;
export const MIN_OVERLAP_SECONDS = 2 / 24;
/** How far a planned recording may fall short of the request before another segment is added. */
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

/** One planned segment of a chained recording, in recording time. */
export interface PlannedSegment {
  /** 1-based. */
  index: number;
  /** Where this segment starts in the recording (the previous one's crossfade start). */
  startSeconds: number;
  durationSeconds: number;
}

export interface ChainPlan {
  /** What the stitched recording will last: the segments minus the crossfades. */
  totalSeconds: number;
  /** The crossfade at every seam; segment k+1 starts from segment k's frame at its length minus this. */
  overlapSeconds: number;
  segments: PlannedSegment[];
}

export interface PlanOptions {
  /** The recipe's frame rate; the shortest crossfade is two of its frames. */
  fps?: number;
  /** The only lengths one run accepts (a Router model's durations); segments snap to one of them. */
  durations?: readonly number[];
}

/** The shortest crossfade: two frames at the recipe's rate (24 fps when it does not say). */
export function minOverlapSeconds(fps?: number): number {
  return round3(Math.max(MIN_OVERLAP_SECONDS, 2 / (fps && fps > 0 ? fps : 24)));
}

function planOf(count: number, length: number, overlap: number): ChainPlan {
  const segments = Array.from({ length: count }, (_, position) => ({
    index: position + 1,
    startSeconds: round3(position * (length - overlap)),
    durationSeconds: length,
  }));
  return { totalSeconds: Math.round((count * length - (count - 1) * overlap) * 100) / 100, overlapSeconds: round3(overlap), segments };
}

/**
 * Plans the fewest segments of at most `segmentMaxSeconds` that cover `totalSeconds` with a short
 * crossfade at every seam, or null when that needs more than {@link MAX_CHAIN_SEGMENTS}.
 *
 * Any length (workflows, the mock): the crossfade comes out of the segments' spare length. It aims
 * for {@link TARGET_OVERLAP_SECONDS}, never under two frames, and when the model has no spare length
 * the recording may come out up to {@link LENGTH_TOLERANCE_SECONDS} short instead of paying for
 * another segment (20 s on a 5 s model is four segments, 19.75 s).
 *
 * Fixed lengths (`durations`, Router models): every segment is the shortest allowed length that still
 * covers the request with the full crossfade (or the most it can take), so the body the model gets
 * is always one it accepts (Kling at 20 s is two 10 s segments with a 0.25 s crossfade, Wan 3 at 8 s
 * two 5 s segments). The recording may then run a little longer than asked.
 */
export function planChain(totalSeconds: number, segmentMaxSeconds: number, options: PlanOptions = {}): ChainPlan | null {
  const minimum = minOverlapSeconds(options.fps);
  const allowed = [...(options.durations ?? [])].filter((value) => value > minimum * 2 && value <= segmentMaxSeconds + 1e-9).sort((a, b) => a - b);
  const longest = allowed.length ? allowed[allowed.length - 1] : segmentMaxSeconds;
  if (!(longest > minimum * 2)) return null;
  const floor = totalSeconds - LENGTH_TOLERANCE_SECONDS;
  for (let count = Math.max(2, Math.ceil(totalSeconds / longest)); count <= MAX_CHAIN_SEGMENTS; count++) {
    if (allowed.length) {
      for (const length of allowed) {
        const spare = (count * length - totalSeconds) / (count - 1);
        const full = count * length - (count - 1) * TARGET_OVERLAP_SECONDS;
        const overlap = full >= floor ? TARGET_OVERLAP_SECONDS : Math.max(minimum, Math.min(TARGET_OVERLAP_SECONDS, spare));
        if (count * length - (count - 1) * overlap >= floor) return planOf(count, length, overlap);
      }
      continue;
    }
    if (count * longest - (count - 1) * minimum < floor) continue;
    const spare = (count * longest - totalSeconds) / (count - 1);
    const overlap = round3(Math.min(TARGET_OVERLAP_SECONDS, Math.max(minimum, spare)));
    return planOf(count, round3(Math.min(longest, (totalSeconds + (count - 1) * overlap) / count)), overlap);
  }
  return null;
}

export type LengthStrategy =
  | { kind: "native"; mechanism: NativeLength; maxSeconds: number }
  | { kind: "workflow"; maxSeconds: number }
  | { kind: "chained"; drive: ChainDrive; segmentMaxSeconds: number; plan: ChainPlan }
  | { kind: "unsupported"; reason: string };

/**
 * Resolves how a recipe makes a recording of `seconds`. `customGraphs` says whether the backend the
 * recipe is placed on runs custom graphs (see {@link backendAllowsCustomGraphs}). Never throws.
 */
export function resolveLengthStrategy(recipe: Recipe, seconds: number, options: { customGraphs?: boolean } = {}): LengthStrategy {
  const max = nativeMaxSeconds(recipe);
  if (max === undefined) return { kind: "unsupported", reason: `${recipe.title} does not make video of a set length.` };
  // A workflow (or the mock) snaps a slightly longer request to its own length, so half a second
  // over is still one run rather than a second paid segment; Router durations are exact.
  const slack = recipe.kind === "router" ? 0.01 : LENGTH_TOLERANCE_SECONDS;
  if (seconds <= max + slack) return { kind: "native", mechanism: recipe.length?.native ?? "single_run", maxSeconds: max };
  if (seconds > MAX_TAKE_SECONDS) return { kind: "unsupported", reason: `A recording is at most ${MAX_TAKE_SECONDS} s.` };
  if (recipe.length?.longer === "workflow" && recipe.kind === "workflow") {
    if (options.customGraphs ?? true) return { kind: "workflow", maxSeconds: max };
    return { kind: "unsupported", reason: `${recipe.title} makes a whole long recording in one workflow, and this backend runs only the graphs it was deployed with. Run it on Comfy Cloud or a self-hosted ComfyUI.` };
  }
  const drive = chainDrive(recipe);
  if (!drive) {
    // An ending frame (or a recipe that cannot start from another run's frame) keeps one run, as
    // long as the model accepts that length; past its known-good length it is unverified.
    const hard = hardMaxSeconds(recipe) ?? max;
    if (seconds <= hard + 0.01) return { kind: "native", mechanism: recipe.length?.native ?? "single_run", maxSeconds: hard };
    const what = recipe.capability === "first_last_to_video" ? "An ending frame pins the end of one run" : `${recipe.title} cannot start a run from another run's last frame`;
    return { kind: "unsupported", reason: `${what}, so it makes at most ${hard} s. Use an image to video recipe for a longer recording, or shorten it.` };
  }
  const plan = planChain(seconds, max, { fps: recipeFps(recipe), durations: recipe.kind === "router" ? recipe.limits.durations : undefined });
  if (!plan) return { kind: "unsupported", reason: `${seconds} s on ${recipe.title} needs more than ${MAX_CHAIN_SEGMENTS} segments. Shorten the recording or pick a model that makes longer runs.` };
  return { kind: "chained", drive, segmentMaxSeconds: max, plan };
}

/** Where every seam sits in the stitched recording: the middle of each crossfade. */
export function seamTimes(plan: Pick<ChainPlan, "overlapSeconds"> & { segments: { durationSeconds: number }[] }): number[] {
  const seams: number[] = [];
  let offset = 0;
  for (let index = 0; index < plan.segments.length - 1; index++) {
    offset += plan.segments[index].durationSeconds - plan.overlapSeconds;
    seams.push(round3(offset + plan.overlapSeconds / 2));
  }
  return seams;
}
