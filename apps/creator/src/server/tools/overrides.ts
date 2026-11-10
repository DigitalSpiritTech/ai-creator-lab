/**
 * Model override (v0.2 F3): pick another recipe for one run, for the rest of a project, or for a
 * rejected candidate, without re-briefing. Every path carries the same shot spec to the new recipe
 * and re-renders the prompt in that model's style on the server, which also re-estimates the cost
 * (the spend gate prices again at submit; a client's estimate is never trusted).
 *
 * - `set_recipe_preference` (roster): the per-project preference by capability.
 * - `regenerate_with` (roster): a new proposal from a candidate's own job, for another recipe.
 * - `rerender_proposal` (internal, the card's selector): the same proposal for another recipe.
 * - `recipe_options` (internal, the card's selector): what the selector lists.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema, PromptStyleSchema, type Recipe, inferPromptStyle, placeRecipe } from "@creator-lab/core/catalog";
import { IdSchema, RecipeIdSchema } from "@creator-lab/core/domain/common";
import { fail } from "@creator-lab/core/domain/failure";
import { GenerationProposalSchema } from "@creator-lab/core/domain/job";
import { ProjectPreferencesSchema, setRecipePreference } from "@creator-lab/core/domain/preferences";
import type { ShotSpec } from "@creator-lab/core/domain/shot-spec";
import { availableRecipes, recipeRunnable } from "@creator-lab/executors/availability";
import { defaultRecipes } from "@creator-lab/recipes/defaults";
import { buildProposal, referenceRange, shotOf } from "@/server/tools/proposals";
import { type ToolContext, defineTool, requireGeneration } from "@/server/tools/registry";

async function catalog(context: ToolContext): Promise<Recipe[]> {
  return context.generation ? context.generation.recipes() : defaultRecipes();
}

export const setRecipePreferenceTool = defineTool({
  name: "set_recipe_preference",
  description:
    "Set this project's preferred recipe for one capability (scope project), or clear it with recipeId null. Every later step of that capability in this project uses it unless a run names its own recipe; other projects keep the Settings default. Nothing is generated.",
  input: z
    .object({
      projectId: IdSchema,
      capability: CapabilitySchema,
      recipeId: RecipeIdSchema.nullable().describe("The recipe to prefer, or null to go back to the Settings default."),
      scope: z.literal("project").default("project").describe("Preferences are per project; the workspace default lives in Settings."),
    })
    .strict(),
  output: z.object({
    projectId: IdSchema,
    capability: CapabilitySchema,
    recipeId: RecipeIdSchema.nullable(),
    recipeTitle: z.string().nullable(),
    preferences: ProjectPreferencesSchema,
    note: z.string(),
  }),
  run: async (context, input) => {
    const { store } = context;
    store.projects.getRequired(input.projectId);
    let recipe: Recipe | undefined;
    if (input.recipeId) {
      recipe = (await catalog(context)).find((entry) => entry.id === input.recipeId);
      if (!recipe) fail("not_found", `There is no recipe ${input.recipeId}. Call list_recipes for the ids.`);
      if (recipe.capability !== input.capability) {
        fail("invalid", `${recipe.title} does ${recipe.capability.replaceAll("_", " ")}, not ${input.capability.replaceAll("_", " ")}.`);
      }
      if (context.generation) {
        const routing = context.generation.routing?.();
        if (routing) {
          const placement = placeRecipe(recipe, routing);
          if (!placement.ok) fail("invalid", `${placement.reason} It cannot be preferred until it can run.`);
        } else if (!recipeRunnable(recipe, { executors: context.generation.executors })) {
          fail("invalid", `${recipe.title} needs a Comfy API key before it can run, so it cannot be preferred yet.`);
        }
      }
    }
    const preferences = store.transaction(() =>
      store.preferences.save(setRecipePreference(store.preferences.get(input.projectId), input.capability, input.recipeId, context.now())),
    );
    const what = input.capability.replaceAll("_", " ");
    return {
      projectId: input.projectId,
      capability: input.capability,
      recipeId: input.recipeId,
      recipeTitle: recipe?.title ?? null,
      preferences,
      note: recipe
        ? `${recipe.title} is now this project's ${what} recipe. A recipe named for one run still wins; other projects keep the Settings default.`
        : `This project's ${what} preference is cleared; the Settings default applies again.`,
    };
  },
});

const ProposalOutput = GenerationProposalSchema;

export const regenerateWith = defineTool({
  name: "regenerate_with",
  description:
    "Propose the same generation as an existing candidate (its shot spec, references, and destination) with another recipe; the prompt is rewritten in that model's style. Use it when the user rejects a candidate and wants another model to try, with no re-brief. Nothing is generated until the user approves the card.",
  input: z
    .object({
      assetId: IdSchema.describe("The candidate to redo, approved or not, active or archived."),
      projectId: IdSchema.optional().describe("The project you are working in; the candidate must belong to it."),
      recipeId: RecipeIdSchema,
      count: z.number().int().min(1).max(4).default(1),
    })
    .strict(),
  output: ProposalOutput,
  run: (context, input) => {
    const { store } = context;
    const asset = store.assets.getRequired(input.assetId);
    if (asset.provenance.source !== "generated") fail("invalid", "Only generated candidates can be regenerated; an upload has no recipe to swap.");
    const job = store.jobs.get(asset.provenance.jobId) ?? fail("not_found", "The job that made this candidate is missing.");
    if (input.projectId && input.projectId !== job.projectId) fail("invalid", "This candidate belongs to another project.");
    const { request } = job;
    // A chained recording (or one of its segments) is redone as the whole recording: its spec, its
    // starting still and voice recording, and its length, not one segment's.
    const chain = store.chains.forJob(job)?.chain;
    // Candidates made before shot specs carry only their prompt; it goes over as written.
    const shot: ShotSpec = chain?.spec ?? request.spec ?? shotOf({ prompt: request.input.prompt });
    const pins = chain ? chain.inputs : request.inputs;
    return buildProposal(context, {
      projectId: job.projectId,
      capability: job.capability,
      recipeId: input.recipeId,
      shot,
      references: [
        ...pins.filter((pin) => pin.role !== "identity").map(({ role, assetId }) => ({ role, assetId })),
        ...(chain?.drive === "audio" && chain.spine ? [{ role: "voice", assetId: chain.spine.assetId }] : []),
      ],
      count: input.count,
      target: request.target,
      aspectRatio: request.input.aspectRatio,
      durationSeconds: chain?.totalSeconds ?? request.input.durationSeconds,
      slots: request.input.slots,
    });
  },
});

export const rerenderProposal = defineTool({
  name: "rerender_proposal",
  description:
    "Internal: the proposal card's recipe selector. Builds the same proposal (spec, references, count, destination) for another recipe: a new id, the prompt rendered in that model's style, and a fresh server estimate. Nothing is generated.",
  input: z.object({ proposal: GenerationProposalSchema, recipeId: RecipeIdSchema, count: z.number().int().min(1).max(4).optional() }).strict(),
  output: ProposalOutput,
  run: (context, { proposal, recipeId, count }) =>
    buildProposal(context, {
      projectId: proposal.projectId,
      capability: proposal.capability,
      recipeId,
      shot: proposal.spec ?? shotOf({ prompt: proposal.prompt }),
      references: proposal.references,
      count: count ?? proposal.count,
      target: proposal.target,
      aspectRatio: proposal.aspectRatio,
      durationSeconds: proposal.durationSeconds,
      slots: proposal.slots,
      seed: proposal.seed,
    }),
});

export const RecipeOptionSchema = z.object({
  id: RecipeIdSchema,
  title: z.string(),
  kind: z.enum(["router", "workflow", "mock"]),
  verified: z.boolean(),
  openWeights: z.boolean(),
  costHint: z.string(),
  promptStyle: PromptStyleSchema,
  /** Whether it takes this step's reference count; when false, `reason` says why. */
  fits: z.boolean(),
  reason: z.string().nullable(),
  /** Where it runs when that is worth saying, for example "Runs on Comfy Cloud because ...". */
  note: z.string().nullable(),
});
export type RecipeOption = z.infer<typeof RecipeOptionSchema>;

export const recipeOptions = defineTool({
  name: "recipe_options",
  description:
    "Internal: what the proposal card's selector lists for a capability and reference count (or for the job behind assetId): recipes available on the configured backends, with whether each takes this many references, plus this project's preference and the Settings default.",
  input: z
    .object({
      projectId: IdSchema,
      capability: CapabilitySchema.optional(),
      references: z.number().int().min(0).max(16).optional(),
      assetId: IdSchema.optional(),
    })
    .strict()
    .refine((value) => value.assetId || value.capability, "Pass a capability or an assetId."),
  output: z.object({
    capability: CapabilitySchema,
    references: z.number().int(),
    options: z.array(RecipeOptionSchema),
    preference: RecipeIdSchema.nullable(),
    settingsDefault: RecipeIdSchema.nullable(),
  }),
  run: async (context, input) => {
    const { store } = context;
    const generation = requireGeneration(context);
    store.projects.getRequired(input.projectId);
    let capability = input.capability;
    let references = input.references ?? 0;
    if (input.assetId) {
      const asset = store.assets.getRequired(input.assetId);
      if (asset.provenance.source !== "generated") fail("invalid", "Only generated candidates can be regenerated.");
      const job = store.jobs.get(asset.provenance.jobId) ?? fail("not_found", "The job that made this candidate is missing.");
      if (job.projectId !== input.projectId) fail("invalid", "This candidate belongs to another project.");
      capability = job.capability;
      references = job.request.inputs.filter((pin) => pin.role !== "voice" && pin.role !== "identity").length;
    }
    const wanted = capability ?? fail("invalid", "Pass a capability or an assetId.");
    const available = availableRecipes(await generation.recipes(), wanted, {
      executors: generation.executors,
      routerModels: store.workspace.get().routerModels,
      routing: generation.routing?.(),
    });
    const options = available.map(({ recipe, note }) => {
      const [min, max] = referenceRange(recipe);
      const fits = references >= min && references <= max;
      return {
        id: recipe.id,
        title: recipe.title,
        kind: recipe.kind,
        verified: recipe.verified !== null,
        openWeights: recipe.openWeights,
        costHint: recipe.costHint,
        promptStyle: inferPromptStyle(recipe),
        fits,
        reason: fits ? null : `Takes ${min === max ? min : `${min} to ${max}`} reference image${max === 1 ? "" : "s"}; this step has ${references}.`,
        note: note || null,
      };
    });
    return {
      capability: wanted,
      references,
      options,
      preference: store.preferences.get(input.projectId).recipes[wanted] ?? null,
      settingsDefault: store.workspace.get().defaultRecipes[wanted] ?? null,
    };
  },
});
