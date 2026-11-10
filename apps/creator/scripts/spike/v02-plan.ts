/**
 * The v0.2 spike plan (Krea 2 character start and the MiniMax H3 checks), built offline: every step's
 * recipe resolved from the starter catalog, slots applied to a copy of the graph, sizes and frame
 * counts checked against each model's rule (17n+5 for H3, 8n+1 for LTX), and a ceiling per run.
 * No network, no keys; `DRY_RUN=1 npm run spike:v02` prints this plan and the test builds it.
 * @packageDocumentation
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  applySlots,
  sidecarProblems,
  WorkflowGraphSchema,
  type AspectRatio,
  type Capability,
  type Recipe,
  type SlotValue,
  type WorkflowGraph,
  type WorkflowRecipe,
} from "@creator-lab/core/catalog";
import { CharacterBibleSchema } from "@creator-lab/core/domain/library";
import { BeatSchema } from "@creator-lab/core/domain/script";
import { defaultRecipes } from "@creator-lab/recipes/defaults";
import { usdToCredits } from "@creator-lab/executors/allowance";
import { ExecutorFailure } from "@creator-lab/executors/jobs";
import { planWorkflow, scaleByLength } from "@creator-lab/executors/workflow";
import { FACE_LOCK, clipPrompt, faceLockPrompt } from "@creator-lab/recipes/prompts";
import { averyBible } from "../../../../tests/support/domain-fixtures";
import { BOTTLE, CHAIN_LINES, DEFAULT_KEYFRAME_NOTES, DIALOGUE_LINE, PERSON_WITH_TRAITS, h3ChainPrompts, h3DialoguePrompt, h3MultiframePrompt } from "./h3-prompts";

export const STEP_IDS = ["krea", "h3-dialogue", "h3-traits", "ltx-dialogue", "ltx-variants", "h3-multiframe", "h3-chain", "h3-max-router"] as const;
export type StepId = (typeof STEP_IDS)[number];

/** The spike's combined budget: 2 USD at the ledger's 210 credits per USD. */
export const DEFAULT_CAP_CREDITS = 420;

export const KREA_RECIPE = "krea-2-turbo-t2i";
export const KREA_RUNS = 3;

/** Stands in for an image the spike makes on the way (segment 1's last frame) until it exists. */
export const DERIVED_IMAGE = "<segment 1 last frame>";

/** Files and timings the spike reads; names resolve under `.data/spike/` unless absolute. */
export interface SpikeInputs {
  /** The approved still both dialogue steps, the chain and the multi-frame graph start from. */
  still: string;
  /** Keyframe stills of the same character for <Picture 2> and <Picture 3>. */
  keyframes: [string, string];
  /** What each keyframe shows, for the multi-frame prompt. */
  keyframeNotes: [string, string];
  /** When the multi-frame clip cuts to each keyframe. */
  keyframeSeconds: [number, number];
  /** Length of the multi-frame clip; long enough for the line before the first cut. */
  multiframeSeconds: number;
  /** The project's character reference sheet, for a reference-to-video model on Router. */
  sheet?: string;
  /** One seed for every video run, so the A/B steps differ only in prompt or setting. */
  seed: number;
}

function pair(value: string | undefined, fallback: readonly [string, string], separator = ","): [string, string] {
  const parts = (value ?? "").split(separator).map((part) => part.trim()).filter(Boolean);
  return parts.length === 2 ? [parts[0], parts[1]] : [fallback[0], fallback[1]];
}

/** Reads the inputs from STILL, KEYFRAMES, KEYFRAME_NOTES (split on `|`), KEYFRAME_SECONDS, MULTIFRAME_SECONDS and SHEET. */
export function spikeInputsFromEnv(env: Record<string, string | undefined> = process.env): SpikeInputs {
  const seconds = pair(env.KEYFRAME_SECONDS, ["3.5", "6"]).map(Number) as [number, number];
  return {
    still: env.STILL?.trim() || "composite.png",
    keyframes: pair(env.KEYFRAMES, ["composite3.png", "boardroom-still.png"]),
    keyframeNotes: pair(env.KEYFRAME_NOTES, DEFAULT_KEYFRAME_NOTES, "|"),
    keyframeSeconds: seconds,
    multiframeSeconds: Number(env.MULTIFRAME_SECONDS ?? "8"),
    sheet: env.SHEET?.trim() || undefined,
    seed: Number(env.SPIKE_SEED ?? "42"),
  };
}

/** STEPS=krea,h3-dialogue,... (default every step), in the order given; unknown names are refused. */
export function parseSteps(value: string | undefined): StepId[] {
  if (!value?.trim()) return [...STEP_IDS];
  const steps = value.split(",").map((step) => step.trim()).filter(Boolean);
  const unknown = steps.filter((step) => !(STEP_IDS as readonly string[]).includes(step));
  if (unknown.length) throw new Error(`Unknown spike step ${unknown.join(", ")}; choose from ${STEP_IDS.join(", ")}.`);
  return [...new Set(steps)] as StepId[];
}

export interface PlannedRun {
  label: string;
  /** The tool the live run calls; both go through the proposal, the gate, the executor and the store. */
  via: "generate_face_candidates" | "propose_candidates";
  recipeId: string;
  capability: Capability;
  prompt: string;
  /** Reference file names in slot order, or {@link DERIVED_IMAGE}. */
  images: string[];
  aspectRatio: AspectRatio;
  durationSeconds?: number;
  slots?: Record<string, number>;
  seed?: number;
  width?: number;
  height?: number;
  frames?: number;
  ceilingUsd: number;
  ceilingCredits: number;
}

export interface PlannedStep {
  id: StepId;
  title: string;
  /** What the step answers for the decisions checklist. */
  question: string;
  runs: PlannedRun[];
  /** Free work: local ffmpeg, catalog and schema reads. */
  local: string[];
  ceilingUsd: number;
  ceilingCredits: number;
  problems: string[];
}

export interface SpikePlan {
  steps: PlannedStep[];
  totalUsd: number;
  totalCredits: number;
  capCredits: number;
  problems: string[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function failureMessage(cause: unknown): string {
  if (cause instanceof ExecutorFailure) return cause.failure.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Checks a frame count against a rule such as `17n+5`. */
export function followsRule(frames: number, rule: string | undefined): boolean {
  const match = rule?.match(/^(\d+)n\+(\d+)$/);
  if (!match) return true;
  const k = Number(match[1]);
  const c = Number(match[2]);
  return frames >= c && (frames - c) % k === 0;
}

/** The Add Guide frame for a cut time, as the template computes it: round(seconds x 24). */
export function frameIndex(seconds: number, fps = 24): number {
  return Math.round(seconds * fps);
}

interface RunDraft {
  label: string;
  via: PlannedRun["via"];
  recipeId: string;
  prompt: string;
  images: string[];
  aspectRatio: AspectRatio;
  durationSeconds?: number;
  slots?: Record<string, number>;
  seed?: number;
}

async function graphOf(recipe: WorkflowRecipe, workflowsDir: string, cache: Map<string, WorkflowGraph>): Promise<WorkflowGraph> {
  const cached = cache.get(recipe.file);
  if (cached) return cached;
  const graph = WorkflowGraphSchema.parse(JSON.parse(await readFile(join(workflowsDir, recipe.file), "utf8")));
  cache.set(recipe.file, graph);
  return graph;
}

/**
 * Resolves one run against its workflow: the executor's own slot planning (sizes, length rule,
 * slot names), the values written into a copy of the graph, and the ceiling scaled by length.
 */
async function planRun(draft: RunDraft, recipes: Recipe[], workflowsDir: string, cache: Map<string, WorkflowGraph>): Promise<{ run?: PlannedRun; problems: string[] }> {
  const recipe = recipes.find((entry) => entry.id === draft.recipeId);
  if (!recipe) return { problems: [`${draft.label}: no recipe ${draft.recipeId} in the catalog.`] };
  if (recipe.kind !== "workflow") return { problems: [`${draft.label}: ${draft.recipeId} is not a workflow recipe.`] };
  const problems: string[] = [];
  const graph = await graphOf(recipe, workflowsDir, cache);
  let plan: ReturnType<typeof planWorkflow>;
  try {
    plan = planWorkflow(recipe, { prompt: draft.prompt, images: draft.images, aspectRatio: draft.aspectRatio, durationSeconds: draft.durationSeconds, slots: draft.slots, seed: draft.seed }, graph, 1);
  } catch (cause) {
    return { problems: [`${draft.label}: ${failureMessage(cause)}`] };
  }
  const copy: WorkflowGraph = structuredClone(graph);
  const values: Record<string, SlotValue> = { ...plan.values };
  for (const image of plan.images) values[image.slot] = basename(image.path);
  try {
    applySlots({ setInput: (node, field, value) => void (copy[node].inputs[field] = value) }, recipe.sidecar, values);
  } catch (cause) {
    problems.push(`${draft.label}: ${failureMessage(cause)}`);
  }
  problems.push(...sidecarProblems(recipe.sidecar, copy).map((problem) => `${draft.label}: ${problem}`));
  const rule = recipe.sidecar.limits.length?.rule;
  if (plan.length !== undefined && !followsRule(plan.length, rule)) problems.push(`${draft.label}: ${plan.length} frames break the ${rule} rule.`);
  for (const [name, value] of Object.entries(draft.slots ?? {})) {
    if (!name.endsWith("Frame")) continue;
    if (plan.length === undefined || value < 0 || value >= plan.length) problems.push(`${draft.label}: ${name} ${value} is outside the ${plan.length ?? "unknown"}-frame clip.`);
  }
  if (recipe.ceilingUsd === undefined) problems.push(`${draft.label}: ${recipe.id} has no ceiling, so it cannot be budgeted.`);
  const ceilingUsd = scaleByLength(recipe.ceilingUsd ?? 0, plan.values.length, recipe.defaults.length ?? recipe.sidecar.limits.length?.default);
  return {
    problems,
    run: {
      ...draft,
      capability: recipe.capability,
      width: plan.width,
      height: plan.height,
      frames: plan.length,
      ceilingUsd,
      ceilingCredits: usdToCredits(ceilingUsd),
    },
  };
}

function ltxDialoguePrompt(line: string): string {
  const beat = BeatSchema.parse({
    index: 1,
    type: "talking",
    purpose: "proof",
    spokenLine: line,
    visual: "A woman at a bright kitchen counter by a window, holding the bottle",
    setting: "a bright kitchen counter by a window",
    productVisible: true,
  });
  return clipPrompt(beat, { product: { name: "Ridgeline 32 oz insulated bottle", appearance: BOTTLE } });
}

/**
 * The LTX prompt the app wrote before the first-frame rewrite (the scene re-described, the product
 * look, a wardrobe-consistency line, and negatives that do nothing at CFG 1), for the ltx-variants A/B.
 */
export function legacyLtxDialoguePrompt(line: string): string {
  return `A woman at a bright kitchen counter by a window, holding the bottle, speaking to the camera with an easy smile, small natural head movement, static phone camera. The product is ${BOTTLE}, no text, lettering, or logo on the product. Quiet ambient sound of a bright kitchen counter by a window. The person says, "${line}" No text on screen. The person's face and clothing stay consistent.`;
}

/** The LTX distilled graph's start-image settings today: strength 0.85, no CRF round trip. */
export const LTX_DEFAULT_SETTINGS = { imageStrength: 0.85, imgCompression: 0 } as const;

/** The run drafts and free work of one step, before validation. */
function stepDrafts(id: StepId, inputs: SpikeInputs): Omit<PlannedStep, "runs" | "ceilingUsd" | "ceilingCredits" | "problems"> & { drafts: RunDraft[] } {
  const bible = CharacterBibleSchema.parse({ ...averyBible(), references: { faceAssetId: null, bodyAssetId: null }, version: 1 });
  switch (id) {
    case "krea":
      return {
        id,
        title: "Krea 2 character start: three measured face-lock runs",
        question: "Is Krea 2 the default character-start recipe, at what ceiling (about 1.5x measured), and is it billed as plan compute or as a partner model?",
        drafts: Array.from({ length: KREA_RUNS }, (_, index) => ({
          label: `krea run ${index + 1}`,
          via: "generate_face_candidates" as const,
          recipeId: KREA_RECIPE,
          prompt: faceLockPrompt(bible, KREA_RECIPE),
          images: [],
          aspectRatio: FACE_LOCK.aspectRatio,
        })),
        local: ["object_info read: the graph's node classes (api_node flag) and model file names", "balance read before and after each run"],
      };
    case "h3-dialogue":
      return {
        id,
        title: "H3 image to video with spoken dialogue",
        question: "Speech clarity, cost and time against LTX on the same still and line.",
        drafts: [{ label: "h3 dialogue", via: "propose_candidates", recipeId: "minimax-h3-i2v", prompt: h3DialoguePrompt(DIALOGUE_LINE), images: [inputs.still], aspectRatio: "9:16", durationSeconds: 5, seed: inputs.seed }],
        local: ["ffprobe of the clip"],
      };
    case "h3-traits":
      return {
        id,
        title: "H3 trait A/B: the h3-dialogue prompt with the bible's face description restated",
        question: "On the same still and seed as h3-dialogue, does restating traits (freckles, hair) exaggerate them? If so, first-frame prompts stay reference-only.",
        drafts: [
          {
            label: "h3 dialogue with traits",
            via: "propose_candidates",
            recipeId: "minimax-h3-i2v",
            prompt: h3DialoguePrompt(DIALOGUE_LINE, PERSON_WITH_TRAITS),
            images: [inputs.still],
            aspectRatio: "9:16",
            durationSeconds: 5,
            seed: inputs.seed,
          },
        ],
        local: ["ffprobe of the clip", "compare face close-ups against h3-dialogue.mp4 at the same frames"],
      };
    case "ltx-dialogue":
      return {
        id,
        title: "LTX 2.5 image to video with the same still and line (baseline)",
        question: "The baseline for the H3 dialogue comparison.",
        drafts: [{ label: "ltx dialogue", via: "propose_candidates", recipeId: "ltx-2.5-i2v", prompt: ltxDialoguePrompt(DIALOGUE_LINE), images: [inputs.still], aspectRatio: "9:16", durationSeconds: 5, seed: inputs.seed }],
        local: ["ffprobe of the clip"],
      };
    case "ltx-variants": {
      const ltx = (label: string, prompt: string, slots: Record<string, number>): RunDraft => ({
        label,
        via: "propose_candidates",
        recipeId: "ltx-2.5-i2v",
        prompt,
        images: [inputs.still],
        aspectRatio: "9:16",
        durationSeconds: 5,
        slots,
        seed: inputs.seed,
      });
      return {
        id,
        title: "LTX 2.5 A/B against ltx-dialogue: the old prompt, then one start-image setting at a time",
        question: "Against ltx-dialogue (new prompt, strength 0.85, CRF 0) on the same seed: does the start-image prompt beat the old one, and do Lightricks' defaults (strength 0.7, CRF 18) give more motion without losing identity?",
        drafts: [
          ltx("ltx old prompt", legacyLtxDialoguePrompt(DIALOGUE_LINE), { ...LTX_DEFAULT_SETTINGS }),
          ltx("ltx strength 0.7", ltxDialoguePrompt(DIALOGUE_LINE), { ...LTX_DEFAULT_SETTINGS, imageStrength: 0.7 }),
          ltx("ltx crf 18", ltxDialoguePrompt(DIALOGUE_LINE), { ...LTX_DEFAULT_SETTINGS, imgCompression: 18 }),
        ],
        local: ["ffprobe of each clip", "watch for a frozen start, identity drift, and dead air against ltx-dialogue.mp4"],
      };
    }
    case "h3-multiframe":
      return {
        id,
        title: "H3 multi-frame: three anchored keyframes, identity across cuts",
        question: "Does identity hold across native cuts, and is native multi-shot the strategy for talking beats over 5 s?",
        drafts: [
          {
            label: "h3 multiframe",
            via: "propose_candidates",
            recipeId: "minimax-h3-multiframe",
            prompt: h3MultiframePrompt(inputs.keyframeSeconds, inputs.keyframeNotes, DIALOGUE_LINE),
            images: [inputs.still, ...inputs.keyframes],
            aspectRatio: "9:16",
            durationSeconds: inputs.multiframeSeconds,
            seed: inputs.seed,
            slots: { image2Frame: frameIndex(inputs.keyframeSeconds[0]), image3Frame: frameIndex(inputs.keyframeSeconds[1]) },
          },
        ],
        local: ["ffprobe of the clip", "contact sheet of the frames at each cut"],
      };
    case "h3-chain": {
      const [first, second] = h3ChainPrompts(CHAIN_LINES);
      return {
        id,
        title: "H3 two-segment chain from the last frame, stitched locally",
        question: "Seam quality of a chained talking beat (the alternative to native multi-shot).",
        drafts: [
          { label: "h3 chain segment 1", via: "propose_candidates", recipeId: "minimax-h3-i2v", prompt: first, images: [inputs.still], aspectRatio: "9:16", durationSeconds: 5, seed: inputs.seed },
          { label: "h3 chain segment 2", via: "propose_candidates", recipeId: "minimax-h3-i2v", prompt: second, images: [DERIVED_IMAGE], aspectRatio: "9:16", durationSeconds: 5, seed: inputs.seed },
        ],
        local: ["ffmpeg: segment 1's last frame as segment 2's start", "ffmpeg: hard-cut and 0.25 s crossfade stitches", "ffmpeg: contact sheet of the seam", "seam difference between the two frames"],
      };
    }
    case "h3-max-router":
      return {
        id,
        title: "H3 Max reference to video on Comfy Router",
        question: "Does Router list an H3 Max or reference-to-video model, what does it cost, and does it take the character reference sheet?",
        drafts: [],
        local: [
          "live Router model list and the MiniMax schemas (free reads)",
          "submits only when an adapter builds a references_to_video body; none does today, so this step records the schema and spends nothing",
        ],
      };
  }
}

/** Builds and validates the plan for the chosen steps. Nothing touches the network. */
export async function buildSpikePlan(options: {
  steps: StepId[];
  inputs: SpikeInputs;
  workflowsDir: string;
  recipes?: Recipe[];
  capCredits?: number;
}): Promise<SpikePlan> {
  const recipes = options.recipes ?? (await defaultRecipes(options.workflowsDir, { mocks: false }));
  const cache = new Map<string, WorkflowGraph>();
  const steps: PlannedStep[] = [];
  for (const id of options.steps) {
    const { drafts, ...step } = stepDrafts(id, options.inputs);
    const runs: PlannedRun[] = [];
    const problems: string[] = [];
    for (const draft of drafts) {
      const planned = await planRun(draft, recipes, options.workflowsDir, cache);
      problems.push(...planned.problems);
      if (planned.run) runs.push(planned.run);
    }
    const ceilingUsd = round2(runs.reduce((sum, run) => sum + run.ceilingUsd, 0));
    steps.push({ ...step, runs, problems, ceilingUsd, ceilingCredits: usdToCredits(ceilingUsd) });
  }
  const totalUsd = round2(steps.reduce((sum, step) => sum + step.ceilingUsd, 0));
  const capCredits = options.capCredits ?? DEFAULT_CAP_CREDITS;
  const problems = steps.flatMap((step) => step.problems);
  if (usdToCredits(totalUsd) > capCredits) problems.push(`The plan's ceilings (${usdToCredits(totalUsd)} credits) exceed the ${capCredits}-credit cap; run fewer steps.`);
  return { steps, totalUsd, totalCredits: usdToCredits(totalUsd), capCredits, problems };
}

/** The plan as the dry run prints it. */
export function formatPlan(plan: SpikePlan): string {
  const lines: string[] = [`v0.2 spike plan (cap ${plan.capCredits} credits, ${round2(plan.capCredits / 210)} USD)`];
  for (const step of plan.steps) {
    lines.push("", `${step.id}: ${step.title}`, `  answers: ${step.question}`);
    for (const run of step.runs) {
      const size = run.width && run.height ? `${run.width}x${run.height}` : "default size";
      const frames = run.frames ? `, ${run.frames} frames` : "";
      const slots = run.slots ? `, ${Object.entries(run.slots).map(([name, value]) => `${name}=${value}`).join(" ")}` : "";
      const seed = run.seed !== undefined ? `, seed ${run.seed}` : "";
      const images = run.images.length ? `, images ${run.images.join(" + ")}` : "";
      lines.push(`  - ${run.label}: ${run.recipeId} via ${run.via}, ${size}${frames}${slots}${seed}${images}; ceiling ${run.ceilingUsd} USD (${run.ceilingCredits} credits)`);
    }
    for (const work of step.local) lines.push(`  - free: ${work}`);
    lines.push(`  step ceiling: ${step.ceilingUsd} USD (${step.ceilingCredits} credits)`);
    for (const problem of step.problems) lines.push(`  PROBLEM: ${problem}`);
  }
  lines.push("", `total ceiling: ${plan.totalUsd} USD (${plan.totalCredits} credits) of the ${plan.capCredits}-credit cap`);
  lines.push(plan.problems.length ? `${plan.problems.length} problem(s); fix them before a live run.` : "plan valid: every graph accepts its slots, sizes and frame counts.");
  return lines.join("\n");
}
