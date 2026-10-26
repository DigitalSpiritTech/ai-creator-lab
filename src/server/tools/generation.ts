/**
 * Generation tools. Every spending step returns a proposal (recipe, prompt, references, count,
 * estimate) and submits nothing; `submit_proposal` is the internal tool the UI gate calls once the
 * user (or auto-approve under the allowance) accepts one.
 * @packageDocumentation
 */
import { z } from "zod";
import { AspectRatioSchema, CapabilitySchema } from "@/lib/catalog";
import { IdSchema, RecipeIdSchema, text } from "@/lib/domain/common";
import { ExportRecordSchema, beginExport, updateCut } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import {
  type CharacterItem,
  type CharacterLink,
  type ProductItem,
  chooseWardrobe,
} from "@/lib/domain/library";
import { GenerationProposalSchema, GenerationTargetSchema, type Job, JobSchema } from "@/lib/domain/job";
import { defaultRecipes, recipesFor } from "@/server/catalog/defaults";
import { runToCompletion, startGeneration } from "@/server/executors/run";
import type { Store } from "@/server/store";
import { clipPrompt, referenceSheetPrompt, refinePrompt, stillPrompt, type StillPromptParts } from "@/server/tools/prompts";
import { buildProposal, candidateRequestId, nearestAspect, proposalRequest, runDeps } from "@/server/tools/proposals";
import { defineTool } from "@/server/tools/registry";

const count = z.number().int().min(1).max(4).default(4);

function projectCast(store: Store, projectId: string): { character?: { item: CharacterItem; link: CharacterLink }; product?: ProductItem } {
  let character: { item: CharacterItem; link: CharacterLink } | undefined;
  let product: ProductItem | undefined;
  for (const link of store.library.listLinks(projectId)) {
    const item = store.library.get(link.itemId);
    if (!item || item.archived) continue;
    if (!character && item.kind === "character" && link.kind === "character") character = { item, link };
    if (!product && item.kind === "product") product = item;
  }
  return { character, product };
}

export const proposeCandidates = defineTool({
  name: "propose_candidates",
  description:
    "Propose a generation (capability, optional recipe, prompt, reference images, count) and return a proposal with the chosen recipe and estimated cost. Nothing is generated until the user approves it. Used for face lock (text_to_image, four candidates), body reference (image_edit from the face), and manual generations.",
  input: z
    .object({
      projectId: IdSchema,
      capability: CapabilitySchema,
      recipeId: RecipeIdSchema.optional(),
      prompt: text(8000),
      referenceAssetIds: z.array(IdSchema).max(8).default([]),
      count,
      target: GenerationTargetSchema.default({ kind: "loose" }),
      aspectRatio: AspectRatioSchema.optional(),
      durationSeconds: z.number().positive().max(60).optional(),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: (context, input) =>
    buildProposal(context, {
      projectId: input.projectId,
      capability: input.capability,
      recipeId: input.recipeId,
      prompt: input.prompt,
      references: input.referenceAssetIds.map((assetId, index) => ({ role: `image${index + 1}`, assetId })),
      count: input.count,
      target: input.target,
      aspectRatio: input.aspectRatio,
      durationSeconds: input.durationSeconds,
    }),
});

export const generateReferenceSheet = defineTool({
  name: "generate_reference_sheet",
  description:
    "Propose this project's character reference sheet from the approved face (reference image 1) and body (reference image 2) in the project's wardrobe. Passing wardrobe records it for the project first.",
  input: z
    .object({
      projectId: IdSchema,
      characterId: IdSchema,
      wardrobe: text(300).optional(),
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(2),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: async (context, input) => {
    const { store } = context;
    const link = store.transaction(() => {
      const current = store.library.getLink(input.projectId, input.characterId);
      if (!current || current.kind !== "character") fail("not_found", "Link this character to the project first.");
      if (!input.wardrobe) return current;
      const chosen = chooseWardrobe(current, input.wardrobe, context.now());
      return chosen === current ? current : (store.library.updateLink(chosen) as CharacterLink);
    });
    if (!link.wardrobe) fail("invalid", "Choose this project's wardrobe before making a reference sheet.");
    const item = store.library.getRequired(input.characterId);
    if (item.kind !== "character") fail("invalid", "Choose a character from the Library.");
    const { faceAssetId, bodyAssetId } = item.bible.references;
    if (!faceAssetId || !bodyAssetId) fail("invalid", "Lock the face and the body reference before making a reference sheet.");
    return buildProposal(context, {
      projectId: input.projectId,
      capability: "image_edit",
      recipeId: input.recipeId,
      prompt: referenceSheetPrompt(item.bible, link.wardrobe),
      references: [
        { role: "image1", assetId: faceAssetId },
        { role: "image2", assetId: bodyAssetId },
      ],
      count: input.count,
      target: { kind: "reference_sheet", characterId: item.id },
      aspectRatio: "16:9",
    });
  },
});

export const composeStill = defineTool({
  name: "compose_still",
  description:
    "Propose start-frame candidates for one beat: the approved reference sheet (or face plus body) as the character reference, the product photo, and the beat's visual and setting as the prompt. B-roll beats use the product only.",
  input: z
    .object({
      contentId: IdSchema,
      beatIndex: z.number().int().positive(),
      recipeId: RecipeIdSchema.optional(),
      count,
    })
    .strict(),
  output: GenerationProposalSchema,
  run: (context, input) => {
    const { store } = context;
    const content = store.content.getRequired(input.contentId);
    const script = store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This content piece's script version is missing.");
    const beat = script.beats[input.beatIndex - 1] ?? fail("not_found", `Beat ${input.beatIndex} is not in the script.`);
    const { character, product } = projectCast(store, content.projectId);
    const references: { role: string; assetId: string }[] = [];
    const add = (assetId: string) => {
      references.push({ role: `image${references.length + 1}`, assetId });
      return references.length;
    };
    const parts: StillPromptParts = { beat };
    if (character && beat.type === "talking") {
      const { link, item } = character;
      parts.bible = item.bible;
      parts.wardrobe = link.wardrobe;
      if (link.sheetAssetId) {
        parts.character = { mode: "sheet", image: add(link.sheetAssetId) };
      } else if (item.bible.references.faceAssetId) {
        const face = add(item.bible.references.faceAssetId);
        const body = item.bible.references.bodyAssetId ? add(item.bible.references.bodyAssetId) : undefined;
        parts.character = { mode: "face", face, body };
      }
    }
    if (product) {
      const photo = product.imageAssetIds.find((id) => store.assets.get(id)?.state.state === "active");
      parts.product = { name: product.name, image: photo ? add(photo) : undefined };
    }
    return buildProposal(context, {
      projectId: content.projectId,
      capability: references.length ? "image_edit" : "text_to_image",
      recipeId: input.recipeId,
      prompt: stillPrompt(parts),
      references,
      count: input.count,
      target: { kind: "shot", contentId: content.id, beatIndex: beat.index, slot: "still" },
      aspectRatio: "9:16",
    });
  },
});

export const refineStill = defineTool({
  name: "refine_still",
  description:
    "Propose a text-guided edit of one candidate image when it is close but not right. The result lands where the original did (the same beat or reference sheet).",
  input: z
    .object({
      assetId: IdSchema,
      instruction: text(1000),
      recipeId: RecipeIdSchema.optional(),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: (context, input) => {
    const { store } = context;
    const asset = store.assets.getRequired(input.assetId);
    if (asset.kind !== "image" && asset.kind !== "sheet") fail("invalid", "Only still images can be refined.");
    if (!asset.projectId) fail("invalid", "Refine images inside a project.");
    const source = asset.provenance.source === "generated" ? store.jobs.get(asset.provenance.jobId) : undefined;
    return buildProposal(context, {
      projectId: asset.projectId,
      capability: "image_edit",
      recipeId: input.recipeId,
      prompt: refinePrompt(input.instruction),
      references: [{ role: "image1", assetId: asset.id }],
      count: 1,
      target: source?.request.target ?? { kind: "loose" },
      aspectRatio: nearestAspect(asset.width, asset.height),
    });
  },
});

export const generateClip = defineTool({
  name: "generate_clip",
  description:
    "Propose a clip for one beat from its approved still (the first frame). Talking beats carry the spoken line in quotes for synchronized audio; b-roll is ambient sound only.",
  input: z
    .object({
      contentId: IdSchema,
      beatIndex: z.number().int().positive(),
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(1),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: (context, input) => {
    const { store } = context;
    const content = store.content.getRequired(input.contentId);
    const script = store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This content piece's script version is missing.");
    const beat = script.beats[input.beatIndex - 1] ?? fail("not_found", `Beat ${input.beatIndex} is not in the script.`);
    const shot = content.shots[input.beatIndex - 1];
    if (!shot || shot.still.state !== "approved") fail("invalid", `Approve a still for beat ${input.beatIndex} before making its clip.`);
    return buildProposal(context, {
      projectId: content.projectId,
      capability: "image_to_video",
      recipeId: input.recipeId,
      prompt: clipPrompt(beat),
      references: [{ role: "image1", assetId: shot.still.assetId }],
      count: input.count,
      target: { kind: "shot", contentId: content.id, beatIndex: beat.index, slot: "clip" },
      aspectRatio: "9:16",
      durationSeconds: beat.durationSeconds,
    });
  },
});

const SubmitResultSchema = z.object({
  requestId: IdSchema,
  outcome: z.enum(["started", "existing", "completed", "failed", "blocked", "needs_confirmation"]),
  job: JobSchema.nullable(),
  assetIds: z.array(IdSchema),
  message: z.string().nullable(),
  reserveUsd: z.number().nonnegative().nullable(),
});

export const submitProposal = defineTool({
  name: "submit_proposal",
  description:
    "Internal: submit an approved proposal as one generation job per candidate. Called by the UI gate after the user approves, or by auto-approve under the allowance; the assistant never calls it on its own. Submitting the same proposal again never runs it twice.",
  input: z
    .object({
      proposal: GenerationProposalSchema,
      confirmUnquoted: z.boolean().default(false).describe("The user accepted a reservation for a recipe without a live price."),
      wait: z.boolean().default(false).describe("Wait for every candidate to finish instead of returning once submitted."),
    })
    .strict(),
  output: z.object({ results: z.array(SubmitResultSchema) }),
  run: async (context, input) => {
    const { proposal } = input;
    const deps = runDeps(context);
    const request = await proposalRequest(context, proposal);
    const results: z.input<typeof SubmitResultSchema>[] = [];
    for (let index = 0; index < proposal.count; index++) {
      const requestId = candidateRequestId(proposal.id, index);
      const started = await startGeneration(
        deps,
        { requestId, projectId: proposal.projectId, ...request, target: proposal.target },
        { confirmUnquoted: input.confirmUnquoted },
      );
      if (started.kind === "blocked" || started.kind === "needs_confirmation") {
        results.push({
          requestId,
          outcome: started.kind,
          job: null,
          assetIds: [],
          message: started.kind === "blocked" ? started.error.message : started.reason,
          reserveUsd: started.kind === "needs_confirmation" ? started.reserveUsd : null,
        });
        break;
      }
      if (started.kind === "failed") {
        results.push({ requestId, outcome: "failed", job: started.job, assetIds: [], message: started.error.message, reserveUsd: null });
        continue;
      }
      let job: Job = started.job;
      let outcome: "started" | "existing" | "completed" | "failed" = started.kind;
      let message: string | null = null;
      let assetIds: string[] = [];
      if (input.wait) {
        const step = await runToCompletion(deps, job.id);
        job = step.job;
        if (step.kind === "completed") {
          outcome = "completed";
          assetIds = step.assets.map((asset) => asset.id);
        } else if (step.kind === "failed") {
          outcome = "failed";
          message = step.error.message;
        }
      } else if (started.kind === "started") {
        void runToCompletion(deps, job.id).catch(() => undefined);
      }
      results.push({ requestId, outcome, job, assetIds, message, reserveUsd: job.reservedUsd });
    }
    return { results };
  },
});

export const assembleAd = defineTool({
  name: "assemble_ad",
  description:
    "Check that every beat has an approved clip and freeze the cut (order, mute, captions) into an export plan. Rendering the 1080 x 1920 MP4 arrives with the assembly task; until then this returns the plan without saving it.",
  input: z
    .object({
      contentId: IdSchema,
      mute: z.boolean().optional(),
      captions: z.boolean().optional(),
    })
    .strict(),
  output: ExportRecordSchema,
  run: ({ store, now, newId }, input) =>
    store.transaction(() => {
      let content = store.content.getRequired(input.contentId);
      if (input.mute !== undefined || input.captions !== undefined) {
        const next = updateCut(content, { mute: input.mute, captions: input.captions }, now());
        if (next.cut.mute !== content.cut.mute || next.cut.captions !== content.cut.captions) content = store.content.update(next);
      }
      const script = store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This content piece's script version is missing.");
      return beginExport(newId(), content, script, (id) => store.assets.get(id), now());
    }),
});

export const listRecipes = defineTool({
  name: "list_recipes",
  description:
    "List recipes that can run a capability, verified first and mocks last, with whether each is verified on a real account, uses open weights, and can run with the keys configured now.",
  input: z.object({ capability: CapabilitySchema.optional() }).strict(),
  output: z.object({
    recipes: z.array(
      z.object({
        id: RecipeIdSchema,
        title: z.string(),
        capability: CapabilitySchema,
        kind: z.enum(["router", "workflow", "mock"]),
        verified: z.boolean(),
        verifiedOn: z.string().nullable(),
        openWeights: z.boolean(),
        costHint: z.string(),
        available: z.boolean(),
      }),
    ),
  }),
  run: async (context, input) => {
    const recipes = context.generation ? await context.generation.recipes() : await defaultRecipes();
    const listed = input.capability
      ? recipesFor(recipes, input.capability)
      : [...recipes].sort((a, b) => Number(a.kind === "mock") - Number(b.kind === "mock") || Number(!a.verified) - Number(!b.verified));
    return {
      recipes: listed.map((recipe) => ({
        id: recipe.id,
        title: recipe.title,
        capability: recipe.capability,
        kind: recipe.kind,
        verified: recipe.verified !== null,
        verifiedOn: recipe.verified,
        openWeights: recipe.openWeights,
        costHint: recipe.costHint,
        available: context.generation ? !!context.generation.executors.forRecipe(recipe) : recipe.kind === "mock",
      })),
    };
  },
});
