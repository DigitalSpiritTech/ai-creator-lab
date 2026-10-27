/**
 * Generation tools. Every spending step returns a proposal (recipe, prompt, references, count,
 * estimate) and submits nothing; `submit_proposal` is the internal tool the UI gate calls once the
 * user (or auto-approve under the allowance) accepts one.
 * @packageDocumentation
 */
import { z } from "zod";
import { AspectRatioSchema, CapabilitySchema } from "@/lib/catalog";
import { IdSchema, RecipeIdSchema, text } from "@/lib/domain/common";
import { AssetSchema } from "@/lib/domain/asset";
import { type ContentPiece, ExportRecordSchema } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import {
  type CharacterItem,
  type CharacterLink,
  type ProductItem,
  type SetItem,
  chooseWardrobe,
} from "@/lib/domain/library";
import { GenerationProposalSchema, GenerationTargetSchema, type Job, JobSchema } from "@/lib/domain/job";
import { assembleAd as assembleExport } from "@/server/assembly";
import { defaultRecipes, recipesFor } from "@/server/catalog/defaults";
import { runToCompletion, startGeneration } from "@/server/executors/run";
import type { Store } from "@/server/store";
import { BODY_REFERENCE, FACE_LOCK, bodyPrompt, clipPrompt, facePrompt, productPhotoPrompt, referenceSheetPrompt, refinePrompt, stillPrompt, type StillPromptParts } from "@/server/tools/prompts";
import { buildProposal, candidateRequestId, nearestAspect, proposalRequest, runDeps } from "@/server/tools/proposals";
import { defineTool } from "@/server/tools/registry";
import { referenceableIn } from "@/server/tools/shared";

const count = z.number().int().min(1).max(4).default(4);

interface ProjectCast {
  character?: { item: CharacterItem; link: CharacterLink };
  product?: ProductItem;
  sets: SetItem[];
}

/** The project's linked, unarchived Library items: the first character and product, and every set. */
function projectCast(store: Store, projectId: string): ProjectCast {
  const cast: ProjectCast = { sets: [] };
  for (const link of store.library.listLinks(projectId)) {
    const item = store.library.get(link.itemId);
    if (!item || item.archived) continue;
    if (!cast.character && item.kind === "character" && link.kind === "character") cast.character = { item, link };
    if (!cast.product && item.kind === "product") cast.product = item;
    if (item.kind === "set") cast.sets.push(item);
  }
  return cast;
}

/**
 * The linked set a beat takes place in: the one whose id or name the beat's setting names (either
 * containing the other, ignoring case), or the only linked set when the beat names no setting.
 */
export function setForBeat(sets: SetItem[], setting: string): SetItem | undefined {
  const wanted = setting.trim().toLowerCase();
  if (!wanted) return sets.length === 1 ? sets[0] : undefined;
  return sets.find((set) => {
    const name = set.name.trim().toLowerCase();
    return set.id === setting.trim() || name === wanted || wanted.includes(name) || name.includes(wanted);
  });
}

/** Whether an asset is an uploaded photo (a real person, product, or place) rather than a generated image. */
function isPhoto(store: Store, assetId: string | null | undefined): boolean {
  return !!assetId && store.assets.get(assetId)?.provenance.source === "upload";
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

export const generateFaceCandidates = defineTool({
  name: "generate_face_candidates",
  description:
    "Propose face-lock candidates for a character linked to this project from its bible alone (text to image, the standard face prompt). The same proposal the chat builds, as one click from the workspace.",
  input: z
    .object({
      projectId: IdSchema,
      characterId: IdSchema,
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(FACE_LOCK.count),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: async (context, input) => {
    const { store } = context;
    const link = store.library.getLink(input.projectId, input.characterId);
    if (!link || link.kind !== "character") fail("not_found", "Link this character to the project first.");
    const item = store.library.getRequired(input.characterId);
    if (item.kind !== "character") fail("invalid", "Choose a character from the Library.");
    return buildProposal(context, {
      projectId: input.projectId,
      capability: FACE_LOCK.capability,
      recipeId: input.recipeId,
      prompt: facePrompt(item.bible),
      references: [],
      count: input.count,
      target: { kind: "character_reference", characterId: item.id, slot: "face" },
      aspectRatio: FACE_LOCK.aspectRatio,
    });
  },
});

export const generateBodyReference = defineTool({
  name: "generate_body_reference",
  description:
    "Propose full-body reference candidates for a character from its locked face (image edit with one reference, the standard athleticwear prompt). Needs the face locked first.",
  input: z
    .object({
      projectId: IdSchema,
      characterId: IdSchema,
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(BODY_REFERENCE.count),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: async (context, input) => {
    const { store } = context;
    const link = store.library.getLink(input.projectId, input.characterId);
    if (!link || link.kind !== "character") fail("not_found", "Link this character to the project first.");
    const item = store.library.getRequired(input.characterId);
    if (item.kind !== "character") fail("invalid", "Choose a character from the Library.");
    const { faceAssetId } = item.bible.references;
    if (!faceAssetId) fail("invalid", "Lock the face before making a body reference.");
    return buildProposal(context, {
      projectId: input.projectId,
      capability: BODY_REFERENCE.capability,
      recipeId: input.recipeId,
      prompt: bodyPrompt(item.bible, "gray", { photographed: isPhoto(store, faceAssetId) }),
      references: [{ role: "image1", assetId: faceAssetId }],
      count: input.count,
      target: { kind: "character_reference", characterId: item.id, slot: "body" },
      aspectRatio: BODY_REFERENCE.aspectRatio,
    });
  },
});

export const generateProductImages = defineTool({
  name: "generate_product_images",
  description:
    "Propose product photo candidates for a product linked to this project from its appearance line (text to image, no brand name in the prompt). Approving one adds it to the product card's images. The appearance line must be filled in first.",
  input: z
    .object({
      projectId: IdSchema,
      productId: IdSchema,
      setting: text(200).optional().describe("Where the product stands, for example 'a light wooden kitchen counter by a window'."),
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(2),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: async (context, input) => {
    const { store } = context;
    const link = store.library.getLink(input.projectId, input.productId);
    if (!link || link.kind !== "product") fail("not_found", "Link this product to the project first.");
    const item = store.library.getRequired(input.productId);
    if (item.kind !== "product") fail("invalid", "Choose a product from the Library.");
    if (!item.appearance?.trim()) fail("invalid", "Describe the product's appearance on its card first (color, material, shape, cap or lid); the prompt is built from it, never from the name.");
    return buildProposal(context, {
      projectId: input.projectId,
      capability: "text_to_image",
      recipeId: input.recipeId,
      prompt: productPhotoPrompt(item, input.setting),
      references: [],
      count: input.count,
      target: { kind: "product_image", productId: item.id },
      aspectRatio: "1:1",
    });
  },
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
      prompt: referenceSheetPrompt(item.bible, link.wardrobe, { photographed: isPhoto(store, faceAssetId) }),
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
    const { character, product, sets } = projectCast(store, content.projectId);
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
      const photographed = isPhoto(store, item.bible.references.faceAssetId);
      if (link.sheetAssetId) {
        parts.character = { mode: "sheet", image: add(link.sheetAssetId), photographed };
      } else if (item.bible.references.faceAssetId) {
        const face = add(item.bible.references.faceAssetId);
        const body = item.bible.references.bodyAssetId ? add(item.bible.references.bodyAssetId) : undefined;
        parts.character = { mode: "face", face, body, photographed };
      }
    }
    if (product) {
      const photo = product.imageAssetIds.find((id) => store.assets.get(id)?.state.state === "active");
      parts.product = { name: product.name, appearance: product.appearance || undefined, image: photo ? add(photo) : undefined };
    }
    const set = setForBeat(sets, beat.setting);
    if (set) {
      const photo = set.imageAssetIds.find((id) => store.assets.get(id)?.state.state === "active");
      parts.set = { name: set.name, image: photo ? add(photo) : undefined, photo: isPhoto(store, photo) };
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
      projectId: IdSchema.optional().describe("The project to refine in; defaults to the image's own project."),
      recipeId: RecipeIdSchema.optional(),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: (context, input) => {
    const { store } = context;
    const asset = store.assets.getRequired(input.assetId);
    if (asset.kind !== "image" && asset.kind !== "sheet") fail("invalid", "Only still images can be refined.");
    const projectId = input.projectId ?? asset.projectId ?? fail("invalid", "Say which project to refine this Library image in.");
    if (!referenceableIn(store, projectId, asset)) {
      fail("invalid", "This image is not part of the project or of a Library item linked to it. Link the item first.");
    }
    const source = asset.provenance.source === "generated" ? store.jobs.get(asset.provenance.jobId) : undefined;
    const target = source && source.projectId === projectId ? source.request.target : { kind: "loose" as const };
    return buildProposal(context, {
      projectId,
      capability: "image_edit",
      recipeId: input.recipeId,
      prompt: refinePrompt(input.instruction, asset.kind === "sheet" ? "sheet" : "still"),
      references: [{ role: "image1", assetId: asset.id }],
      count: 1,
      target,
      aspectRatio: nearestAspect(asset.width, asset.height),
    });
  },
});

/**
 * The ending frame for a first-and-last clip: an approved still from any beat of this content piece,
 * or a reference sheet linked to this project's character. Anything else is refused.
 */
export function endingFrame(store: Store, content: ContentPiece, assetId: string, startAssetId: string): string {
  if (assetId === startAssetId) fail("invalid", "The ending frame must be a different image from the starting still.");
  const asset = store.assets.getRequired(assetId);
  if (asset.state.state !== "active") fail("invalid", "Restore the ending frame before using it.");
  const approvedStill = content.shots.some((shot) => shot.still.state === "approved" && shot.still.assetId === assetId);
  const linkedSheet =
    asset.kind === "sheet" &&
    store.library.listLinks(content.projectId).some((link) => link.kind === "character" && link.sheetAssetId === assetId);
  if (!approvedStill && !linkedSheet) {
    fail("invalid", "The ending frame must be an approved still in this content piece or the project's reference sheet.");
  }
  return assetId;
}

export const generateClip = defineTool({
  name: "generate_clip",
  description:
    "Propose a clip for one beat from its approved still (the first frame). Talking beats carry the spoken line in quotes for synchronized audio; b-roll is ambient sound only. With mode first_last, the clip also ends on lastAssetId, which must be an approved still in this content piece or the project's reference sheet; use it only when that ending still was composed for the same shot, since unrelated endpoints produce a dissolve.",
  input: z
    .object({
      contentId: IdSchema,
      beatIndex: z.number().int().positive(),
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(1),
      mode: z.enum(["start", "first_last"]).default("start").describe("start animates from the approved still; first_last also lands on an ending frame."),
      lastAssetId: IdSchema.optional().describe("The ending frame for mode first_last."),
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
    if (input.mode === "start" && input.lastAssetId) fail("invalid", "An ending frame needs mode first_last.");
    const firstLast = input.mode === "first_last";
    const lastAssetId = firstLast
      ? endingFrame(store, content, input.lastAssetId ?? fail("invalid", "Choose the ending frame (lastAssetId) for a first-and-last clip."), shot.still.assetId)
      : undefined;
    return buildProposal(context, {
      projectId: content.projectId,
      capability: firstLast ? "first_last_to_video" : "image_to_video",
      recipeId: input.recipeId,
      prompt: (() => {
        const cast = projectCast(store, content.projectId);
        return clipPrompt(beat, {
          wardrobe: beat.type === "talking" ? cast.character?.link.wardrobe : undefined,
          product: cast.product ? { name: cast.product.name, appearance: cast.product.appearance || undefined } : undefined,
        });
      })(),
      references: lastAssetId
        ? [
            { role: "first", assetId: shot.still.assetId },
            { role: "last", assetId: lastAssetId },
          ]
        : [{ role: "image1", assetId: shot.still.assetId }],
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
    "Join the approved clips in cut order into one 1080 x 1920, 24 fps MP4 with the beats' on-screen text burned in (unless captions is false) and audio kept (unless mute is true). Every beat needs an approved clip first. Returns the saved export record (sources, hashes, script version, options, output hash, duration) and the export asset. Passing the same exportId again returns the same export instead of rendering twice.",
  input: z
    .object({
      contentId: IdSchema,
      exportId: IdSchema.optional().describe("Optional id that makes retries safe; reuse it to get the same export back."),
      mute: z.boolean().optional(),
      captions: z.boolean().optional(),
    })
    .strict(),
  output: z.object({ export: ExportRecordSchema, asset: AssetSchema.nullable() }),
  run: ({ store, now, newId }, input) => assembleExport(store, input, { now, newId }),
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
