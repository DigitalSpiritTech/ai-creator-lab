/**
 * Proposals: choose a recipe, pin references, and estimate one run, without spending. Submitting an
 * accepted proposal goes through the run orchestration, one idempotent job per candidate.
 * @packageDocumentation
 */
import { createHash } from "node:crypto";
import { type AspectRatio, type Capability, type Recipe, imageSlotNames } from "@/lib/catalog";
import { AspectRatioSchema } from "@/lib/catalog";
import type { Asset } from "@/lib/domain/asset";
import { fail } from "@/lib/domain/failure";
import {
  type EstimateSummary,
  type GenerationInput,
  type GenerationProposal,
  GenerationProposalSchema,
  type GenerationTarget,
  type JobInput,
} from "@/lib/domain/job";
import { DEFAULT_RECIPE_IDS } from "@/server/catalog/defaults";
import type { EstimateOutcome, ExecutorSet } from "@/server/executors";
import type { RunDeps } from "@/server/executors/run";
import type { ToolContext } from "@/server/tools/registry";
import { requireGeneration } from "@/server/tools/registry";
import { linkedReferenceIds, referenceableIn } from "@/server/tools/shared";

export interface ProposalSpec {
  projectId: string;
  capability: Capability;
  recipeId?: string;
  prompt: string;
  references: { role: string; assetId: string }[];
  count: number;
  target: GenerationTarget;
  aspectRatio?: AspectRatio;
  durationSeconds?: number;
  /** Extra named workflow slots, such as a voice sample's transcript for a cloning model. */
  slots?: Record<string, string | number | boolean>;
}

/** How many reference images a recipe accepts, as [min, max]. */
export function referenceRange(recipe: Recipe): [number, number] {
  if (recipe.kind === "workflow") {
    const slots = imageSlotNames(recipe.sidecar).length;
    return [slots, slots];
  }
  if (recipe.kind === "router") {
    const images = recipe.fieldMap.images;
    return images ? [images.min, images.max] : [0, 0];
  }
  return [0, recipe.limits.maxReferences ?? 16];
}

function fits(recipe: Recipe, references: number): boolean {
  const [min, max] = referenceRange(recipe);
  return references >= min && references <= max;
}

/**
 * Picks the recipe for a step: the requested one, else the workspace default, else the starter
 * primary, then the hosted alternative, then any runnable recipe, then the mock. Only recipes whose
 * executor is configured and that take this many references qualify.
 */
export function pickRecipe(
  recipes: Recipe[],
  executors: ExecutorSet,
  capability: Capability,
  references: number,
  preferred: (string | undefined)[],
): Recipe {
  const runnable = (recipe: Recipe | undefined): recipe is Recipe =>
    !!recipe && recipe.capability === capability && !!executors.forRecipe(recipe) && fits(recipe, references);
  const byId = (id: string | undefined) => (id ? recipes.find((recipe) => recipe.id === id) : undefined);
  const [requested, ...others] = preferred;
  if (requested) {
    const recipe = byId(requested);
    if (!recipe) fail("not_found", `There is no recipe ${requested}.`);
    if (recipe.capability !== capability) fail("invalid", `${recipe.title} does ${recipe.capability.replaceAll("_", " ")}, not ${capability.replaceAll("_", " ")}.`);
    if (!executors.forRecipe(recipe)) fail("invalid", `${recipe.title} needs a Comfy API key in .env.local before it can run.`);
    if (!fits(recipe, references)) fail("invalid", `${recipe.title} takes ${referenceRange(recipe).join(" to ")} reference images; this step has ${references}.`);
    return recipe;
  }
  const starter = DEFAULT_RECIPE_IDS[capability];
  for (const id of [...others, starter?.primary, ...(starter?.siblings ?? [])]) {
    const recipe = byId(id);
    if (runnable(recipe)) return recipe;
  }
  // Open weights first: a sibling workflow that takes this many references (the one-, two- and
  // three-reference Qwen graphs) comes before the hosted alternative.
  const rank = (recipe: Recipe) => Number(recipe.kind === "mock") * 4 + Number(!recipe.openWeights) * 2 + Number(!recipe.verified);
  const ranked = recipes.filter(runnable).sort((a, b) => rank(a) - rank(b));
  const openWeights = ranked.find((recipe) => recipe.openWeights && recipe.kind !== "mock");
  if (openWeights) return openWeights;
  const hosted = byId(starter?.hosted);
  if (runnable(hosted)) return hosted;
  if (ranked[0]) return ranked[0];
  return fail("invalid", `No configured recipe can do ${capability.replaceAll("_", " ")} with ${references} reference image${references === 1 ? "" : "s"}.`);
}

/**
 * Loads proposal references, checking they are active stills (or, for a voice-over, one voice
 * recording) from this project or the Library.
 */
export function referenceAssets(context: ToolContext, projectId: string, references: { role: string; assetId: string }[]): Asset[] {
  const linked = linkedReferenceIds(context.store, projectId);
  const assets = references.map(({ assetId }) => {
    const asset = context.store.assets.getRequired(assetId);
    if (asset.state.state !== "active") fail("invalid", "Restore every reference before using it.");
    if (asset.kind !== "image" && asset.kind !== "sheet" && asset.kind !== "audio") fail("invalid", "References must be still images, reference sheets, or a voice recording.");
    if (!referenceableIn(context.store, projectId, asset, linked)) {
      fail("invalid", "References must come from this project or from a Library item linked to it. Link the item first.");
    }
    return asset;
  });
  if (assets.filter((asset) => asset.kind === "audio").length > 1) fail("invalid", "A generation takes one voice recording.");
  return assets;
}

function generationInput(spec: Pick<ProposalSpec, "prompt" | "aspectRatio" | "durationSeconds" | "slots">, assets: Asset[]): GenerationInput {
  const voice = assets.find((asset) => asset.kind === "audio");
  return {
    prompt: spec.prompt,
    images: assets.filter((asset) => asset.kind !== "audio").map((asset) => asset.relativePath),
    ...(voice ? { audio: voice.relativePath } : {}),
    ...(spec.aspectRatio ? { aspectRatio: spec.aspectRatio } : {}),
    ...(spec.durationSeconds ? { durationSeconds: spec.durationSeconds } : {}),
    ...(spec.slots && Object.keys(spec.slots).length ? { slots: spec.slots } : {}),
  };
}

export function summarizeEstimate(estimate: EstimateOutcome): EstimateSummary {
  switch (estimate.kind) {
    case "free":
      return { kind: "free", usd: 0, credits: 0, note: estimate.note };
    case "quoted":
      return { kind: "quoted", usd: estimate.usd, credits: estimate.credits, source: estimate.source, note: estimate.note };
    case "unquoted":
      return { kind: "unquoted", usd: estimate.ceilingUsd, credits: null, note: estimate.note };
    case "rejected":
      return { kind: "rejected", usd: null, credits: null, note: estimate.error.message };
  }
}

/** The closest catalog aspect ratio to an image's size. */
export function nearestAspect(width: number, height: number): AspectRatio {
  const ratio = width / height;
  let best: AspectRatio = "9:16";
  for (const option of AspectRatioSchema.options) {
    const [w, h] = option.split(":").map(Number);
    const [bw, bh] = best.split(":").map(Number);
    if (Math.abs(w / h - ratio) < Math.abs(bw / bh - ratio)) best = option;
  }
  return best;
}

/** Builds and estimates a proposal. Nothing is submitted. */
export async function buildProposal(context: ToolContext, spec: ProposalSpec): Promise<GenerationProposal> {
  const generation = requireGeneration(context);
  context.store.projects.getRequired(spec.projectId);
  const assets = referenceAssets(context, spec.projectId, spec.references);
  const recipes = await generation.recipes();
  const recipe = pickRecipe(recipes, generation.executors, spec.capability, assets.filter((asset) => asset.kind !== "audio").length, [
    spec.recipeId,
    context.store.workspace.get().defaultRecipes[spec.capability],
  ]);
  const id = context.newId();
  const executor = generation.executors.forRecipe(recipe)!;
  const slots = recipe.kind === "workflow" ? Object.fromEntries(Object.entries(spec.slots ?? {}).filter(([name]) => name in recipe.sidecar.slots)) : {};
  const estimate = await executor.estimate({ requestId: id, projectId: spec.projectId, recipe, input: generationInput({ ...spec, slots }, assets) });
  return GenerationProposalSchema.parse({
    id,
    projectId: spec.projectId,
    capability: spec.capability,
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    prompt: spec.prompt,
    references: spec.references,
    aspectRatio: spec.aspectRatio,
    durationSeconds: spec.durationSeconds,
    ...(Object.keys(slots).length ? { slots } : {}),
    count: spec.count,
    target: spec.target,
    estimate: summarizeEstimate(estimate),
  });
}

/** A stable request id per candidate, so submitting the same proposal twice never runs twice. */
export function candidateRequestId(proposalId: string, index: number): string {
  const hex = createHash("sha256").update(`${proposalId}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function runDeps(context: ToolContext): RunDeps {
  const generation = requireGeneration(context);
  return {
    store: context.store,
    executors: generation.executors,
    allowanceUsd: generation.allowanceUsd,
    now: context.now,
    newId: context.newId,
    sleep: generation.sleep,
    poster: generation.poster,
  };
}

/** The recipe, semantic input, and pinned references a proposal turns into. */
export async function proposalRequest(
  context: ToolContext,
  proposal: GenerationProposal,
): Promise<{ recipe: Recipe; input: GenerationInput; inputs: JobInput[] }> {
  const generation = requireGeneration(context);
  const recipe = (await generation.recipes()).find((entry) => entry.id === proposal.recipeId);
  if (!recipe) fail("not_found", `There is no recipe ${proposal.recipeId}.`);
  if (recipe.capability !== proposal.capability) fail("invalid", "The proposal's recipe does not match its capability.");
  const assets = referenceAssets(context, proposal.projectId, proposal.references);
  const inputs = assets.map((asset, index) => ({ role: proposal.references[index].role, assetId: asset.id, sha256: asset.sha256 }));
  return { recipe, input: generationInput(proposal, assets), inputs };
}
