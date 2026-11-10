/**
 * Proposals: choose a recipe, pin references, and estimate one run, without spending. Submitting an
 * accepted proposal goes through the run orchestration, one idempotent job per candidate.
 * @packageDocumentation
 */
import { createHash } from "node:crypto";
import { type AspectRatio, type BackendRouting, type Capability, type Placement, type PromptStyle, type Recipe, bindRecipe, imageSlotNames, placeRecipe, placedTitle, placementNote } from "@creator-lab/core/catalog";
import { AspectRatioSchema } from "@creator-lab/core/catalog";
import type { Asset } from "@creator-lab/core/domain/asset";
import { fail } from "@creator-lab/core/domain/failure";
import {
  type EstimateSummary,
  type GenerationInput,
  type GenerationProposal,
  GenerationProposalSchema,
  type GenerationTarget,
  type JobInput,
} from "@creator-lab/core/domain/job";
import { EDITED_PROMPT_LIMIT, type ShotSpec, type ShotSpecInput, ShotSpecSchema } from "@creator-lab/core/domain/shot-spec";
import { DEFAULT_RECIPE_IDS, purposeRecipe } from "@creator-lab/recipes/defaults";
import type { EstimateOutcome, ExecutorSet } from "@creator-lab/executors";
import type { RunDeps } from "@/server/generation/run";
import { renderPrompt } from "@creator-lab/recipes/render";
import { serverPlugins } from "@/plugins/server";
import type { ToolContext } from "@/server/tools/registry";
import { requireGeneration } from "@/server/tools/registry";
import { linkedReferenceIds, referenceableIn } from "@/server/tools/shared";

export interface ProposalSpec {
  projectId: string;
  capability: Capability;
  recipeId?: string;
  /** The shot spec the prompt is rendered from for whichever recipe runs. */
  shot?: ShotSpecInput;
  /** A prompt written by hand; used when there is no `shot` (it becomes a free spec). */
  prompt?: string;
  references: { role: string; assetId: string }[];
  count: number;
  target: GenerationTarget;
  aspectRatio?: AspectRatio;
  durationSeconds?: number;
  /** Extra named workflow slots, such as a voice sample's transcript for a cloning model. */
  slots?: Record<string, string | number | boolean>;
  /** A fixed workflow seed, so two proposals can differ only in prompt or settings. */
  seed?: number;
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
 * executor is configured and that take this many references qualify. With `routing`, a recipe also
 * needs a backend that can run it (the default backend or the Comfy Cloud fallback), so a workflow
 * the default backend lacks nodes for is skipped, and a requested one is refused with the reason.
 */
export function pickRecipe(
  recipes: Recipe[],
  executors: ExecutorSet,
  capability: Capability,
  references: number,
  preferred: (string | undefined)[],
  routing?: BackendRouting,
): Recipe {
  const placeable = (recipe: Recipe): Placement => (routing ? placeRecipe(recipe, routing) : { ok: true, backend: null });
  const canRun = (recipe: Recipe) => (routing ? placeable(recipe).ok : !!executors.forRecipe(recipe));
  const runnable = (recipe: Recipe | undefined): recipe is Recipe =>
    !!recipe && recipe.capability === capability && canRun(recipe) && fits(recipe, references);
  const byId = (id: string | undefined) => (id ? recipes.find((recipe) => recipe.id === id) : undefined);
  const [requested, ...others] = preferred;
  if (requested) {
    const recipe = byId(requested);
    if (!recipe) fail("not_found", `There is no recipe ${requested}.`);
    if (recipe.capability !== capability) fail("invalid", `${recipe.title} does ${recipe.capability.replaceAll("_", " ")}, not ${capability.replaceAll("_", " ")}.`);
    if (routing) {
      const placement = placeable(recipe);
      if (!placement.ok) fail("invalid", placement.reason);
    } else if (!executors.forRecipe(recipe)) fail("invalid", `${recipe.title} needs a Comfy API key in .env.local before it can run.`);
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

function generationInput(spec: { prompt: string } & Pick<ProposalSpec, "aspectRatio" | "durationSeconds" | "slots" | "seed">, assets: Asset[]): GenerationInput {
  const voice = assets.find((asset) => asset.kind === "audio");
  return {
    prompt: spec.prompt,
    images: assets.filter((asset) => asset.kind !== "audio").map((asset) => asset.relativePath),
    ...(voice ? { audio: voice.relativePath } : {}),
    ...(spec.aspectRatio ? { aspectRatio: spec.aspectRatio } : {}),
    ...(spec.durationSeconds ? { durationSeconds: spec.durationSeconds } : {}),
    ...(spec.slots && Object.keys(spec.slots).length ? { slots: spec.slots } : {}),
    ...(spec.seed !== undefined ? { seed: spec.seed } : {}),
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

/** A face lock from text: the step whose purpose default is `character_start`. */
export function isFaceLock(spec: Pick<ProposalSpec, "capability" | "target">): boolean {
  return spec.capability === "text_to_image" && spec.target.kind === "character_reference" && spec.target.slot === "face";
}

/**
 * The recipe a proposal runs, first match wins (documented in `@/lib/domain/preferences`): the
 * requested one, else this project's preference for the capability, else the workspace default,
 * else the purpose default (`character_start` for a face lock, when configured and verified), else
 * the capability's starter chain. Only the requested recipe is strict; the rest are skipped when
 * they cannot run here or cannot take this many references.
 */
export async function proposalRecipe(
  context: ToolContext,
  spec: Pick<ProposalSpec, "capability" | "recipeId" | "target"> & { projectId?: string },
  references: number,
): Promise<Recipe> {
  const generation = requireGeneration(context);
  const recipes = await generation.recipes();
  return pickRecipe(
    recipes,
    generation.executors,
    spec.capability,
    references,
    [
      spec.recipeId,
      spec.projectId ? context.store.preferences.get(spec.projectId).recipes[spec.capability] : undefined,
      context.store.workspace.get().defaultRecipes[spec.capability],
      isFaceLock(spec) ? purposeRecipe(recipes, "character_start")?.id : undefined,
    ],
    generation.routing?.(),
  );
}

/**
 * The recipe bound to the backend it runs on, with the title and note the proposal shows. Without
 * routing the recipe is returned as it is.
 */
export function placeForProposal(context: ToolContext, recipe: Recipe): { recipe: Recipe; title: string; note: string; backendId?: string } {
  const routing = requireGeneration(context).routing?.();
  if (!routing) return { recipe, title: recipe.title, note: "" };
  const placement = placeRecipe(recipe, routing);
  if (!placement.ok) fail("invalid", placement.reason);
  const bound = bindRecipe(recipe, placement.backend);
  return {
    recipe: bound,
    title: placedTitle(recipe, placement.backend),
    note: placementNote(placement),
    ...(bound.kind === "workflow" && bound.backendId ? { backendId: bound.backendId } : {}),
  };
}

/** The shot spec of a proposal spec: its own, or the hand-written prompt as a free spec. */
export function shotOf(spec: Pick<ProposalSpec, "shot" | "prompt">): ShotSpec {
  if (spec.shot) return ShotSpecSchema.parse(spec.shot);
  if (!spec.prompt) fail("invalid", "A proposal needs a prompt or a shot spec.");
  const prompt = spec.prompt.trim();
  if (prompt.length > EDITED_PROMPT_LIMIT) {
    fail("invalid", `This prompt is ${prompt.length.toLocaleString("en-US")} characters, longer than the ${EDITED_PROMPT_LIMIT.toLocaleString("en-US")} another recipe takes. Shorten it on the card first.`);
  }
  return ShotSpecSchema.parse({ kind: "free", prompt });
}

/** The spec rendered in the recipe's prompt style; a spec the model cannot take is refused readably. */
export function renderFor(recipe: Recipe, shot: ShotSpec): { prompt: string; style: PromptStyle } {
  const rendered = renderPrompt(shot, recipe, serverPlugins.renderers());
  if (!rendered.ok) fail("invalid", rendered.error);
  return { prompt: rendered.prompt, style: rendered.style };
}

/** Builds and estimates a proposal. Nothing is submitted. */
export async function buildProposal(context: ToolContext, spec: ProposalSpec): Promise<GenerationProposal> {
  const generation = requireGeneration(context);
  context.store.projects.getRequired(spec.projectId);
  if (spec.target.kind === "piece") {
    // A plugin piece's slot must exist in this project, or the outputs would land nowhere.
    const piece = context.store.pieces.get(spec.target.contentId);
    if (!piece || piece.projectId !== spec.projectId) fail("not_found", "This content piece is not in the project.");
    if (!piece.slots[spec.target.slot]) fail("invalid", `This ${piece.type} has no ${spec.target.slot} slot. Its slots: ${Object.keys(piece.slots).join(", ")}.`);
  }
  const assets = referenceAssets(context, spec.projectId, spec.references);
  const picked = await proposalRecipe(context, spec, assets.filter((asset) => asset.kind !== "audio").length);
  const placed = placeForProposal(context, picked);
  const recipe = placed.recipe;
  const shot = shotOf(spec);
  const { prompt, style } = renderFor(recipe, shot);
  const id = context.newId();
  const executor = generation.executors.forRecipe(recipe) ?? fail("invalid", `${placed.title} cannot run with the keys and backends configured now.`);
  const slots = recipe.kind === "workflow" ? Object.fromEntries(Object.entries(spec.slots ?? {}).filter(([name]) => name in recipe.sidecar.slots)) : {};
  const estimated = summarizeEstimate(await executor.estimate({ requestId: id, projectId: spec.projectId, recipe, input: generationInput({ ...spec, prompt, slots }, assets) }));
  // Where it runs comes first, so a fallback to Comfy Cloud is never silent.
  const estimate = placed.note ? { ...estimated, note: `${placed.note} ${estimated.note}`.trim().slice(0, 600) } : estimated;
  return GenerationProposalSchema.parse({
    id,
    projectId: spec.projectId,
    capability: spec.capability,
    recipeId: recipe.id,
    recipeTitle: placed.title,
    ...(placed.backendId ? { backendId: placed.backendId } : {}),
    prompt,
    spec: shot,
    promptStyle: style,
    references: spec.references,
    aspectRatio: spec.aspectRatio,
    durationSeconds: spec.durationSeconds,
    ...(Object.keys(slots).length ? { slots } : {}),
    ...(spec.seed !== undefined && recipe.kind === "workflow" ? { seed: spec.seed } : {}),
    count: spec.count,
    target: spec.target,
    estimate,
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
    operatorCeilingUsd: generation.operatorCeilingUsd,
    now: context.now,
    newId: context.newId,
    sleep: generation.sleep,
    poster: generation.poster,
  };
}

/**
 * The catalog recipe bound to the backend the proposal named. The backend must still be able to run
 * it; a workflow proposal made before backends existed runs where it would now only when that is not
 * a fallback, so a changed backend always comes back as a new proposal.
 */
export function boundForSubmit(routing: BackendRouting | undefined, recipe: Recipe, backendId: string | undefined): Recipe {
  if (!routing || recipe.kind !== "workflow") return recipe;
  const placement = placeRecipe(recipe, routing, backendId);
  if (!placement.ok) fail("invalid", placement.reason);
  if (placement.fallbackFrom) fail("invalid", `${placementNote(placement)} Propose it again to run it there.`);
  return bindRecipe(recipe, placement.backend);
}

/** The recipe, semantic input, and pinned references a proposal turns into. */
export async function proposalRequest(
  context: ToolContext,
  proposal: GenerationProposal,
): Promise<{ recipe: Recipe; input: GenerationInput; inputs: JobInput[]; spec?: ShotSpec }> {
  const generation = requireGeneration(context);
  const listed = (await generation.recipes()).find((entry) => entry.id === proposal.recipeId);
  if (!listed) fail("not_found", `There is no recipe ${proposal.recipeId}.`);
  if (listed.capability !== proposal.capability) fail("invalid", "The proposal's recipe does not match its capability.");
  const recipe = boundForSubmit(generation.routing?.(), listed, proposal.backendId);
  const assets = referenceAssets(context, proposal.projectId, proposal.references);
  const inputs = assets.map((asset, index) => ({ role: proposal.references[index].role, assetId: asset.id, sha256: asset.sha256 }));
  // The server renders the prompt from the spec for the recipe that runs; only a prompt the person
  // edited on the card (bounded by EditedPromptSchema at the gate) replaces it.
  const prompt = proposal.spec && !proposal.promptEdited ? renderFor(recipe, proposal.spec).prompt : proposal.prompt;
  return { recipe, input: generationInput({ ...proposal, prompt }, assets), inputs, ...(proposal.spec ? { spec: proposal.spec } : {}) };
}
