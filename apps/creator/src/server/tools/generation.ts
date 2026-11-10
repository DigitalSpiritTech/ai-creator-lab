/**
 * Generation tools. Every spending step returns a proposal (recipe, prompt, references, count,
 * estimate) and submits nothing; `submit_proposal` is the internal tool the UI gate calls once the
 * user (or auto-approve under the allowance) accepts one.
 * @packageDocumentation
 */
import { z } from "zod";
import { AspectRatioSchema, CapabilitySchema, placeRecipe, placementNote } from "@creator-lab/core/catalog";
import { IdSchema, RecipeIdSchema, text } from "@creator-lab/core/domain/common";
import { type Asset, AssetSchema } from "@creator-lab/core/domain/asset";
import { type ContentPiece, ExportRecordSchema } from "@creator-lab/core/domain/content";
import { fail } from "@creator-lab/core/domain/failure";
import {
  type CharacterItem,
  type CharacterLink,
  type ProductItem,
  type SetItem,
  chooseWardrobe,
} from "@creator-lab/core/domain/library";
import { GenerationProposalSchema, GenerationTargetSchema, type Job, JobSchema } from "@creator-lab/core/domain/job";
import { QUICK_AD } from "@creator-lab/core/domain/quick-ad";
import { EditedPromptSchema, type ShotSpecInput } from "@creator-lab/core/domain/shot-spec";
import { assembleAd as assembleExport } from "@/server/assembly";
import { defaultRecipes, recipesFor } from "@creator-lab/recipes/defaults";
import { BudgetCrossingSchema, SpendWarningSchema, budgetCrossing, describeCrossing } from "@creator-lab/core/domain/spend";
import { reservationUsd } from "@creator-lab/executors/allowance";
import { runToCompletion, spendPolicy, startGeneration } from "@/server/generation/run";
import type { Store } from "@/server/store";
import { BODY_REFERENCE, FACE_GARMENT, FACE_LOCK, inline } from "@creator-lab/recipes/prompts";
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
      slots: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Extra named workflow slots the recipe accepts, such as imageStrength."),
      seed: z.number().int().min(0).max(4_294_967_295).optional().describe("A fixed seed for workflow recipes, to compare prompts or settings on the same noise; omit for a seed per job."),
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
      slots: input.slots,
      seed: input.seed,
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
    // The prompt follows the recipe that runs: Krea 2 reads sentences, Nano Banana a narrative, and so on.
    return buildProposal(context, {
      capability: FACE_LOCK.capability,
      recipeId: input.recipeId,
      target: { kind: "character_reference", characterId: item.id, slot: "face" },
      projectId: input.projectId,
      shot: { kind: "face", visualCore: item.bible.visualCore, garment: FACE_GARMENT },
      references: [],
      count: input.count,
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
      shot: { kind: "body", build: item.bible.build, backdrop: "gray", face: 1, photographed: isPhoto(store, faceAssetId) },
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
      shot: { kind: "product_photo", product: { name: item.name, appearance: item.appearance }, ...(input.setting ? { setting: input.setting } : {}) },
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
      shot: { kind: "sheet", visualCore: item.bible.visualCore, wardrobe: link.wardrobe, face: 1, body: 2, photographed: isPhoto(store, faceAssetId) },
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
      count: z.number().int().min(1).max(4).optional().describe("Candidates to make: 4 by default, 1 in a Quick Ad."),
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
    const parts: Extract<ShotSpecInput, { kind: "still" }> = { kind: "still", beat };
    if (character && beat.type === "talking") {
      const { link, item } = character;
      parts.visualCore = item.bible.visualCore;
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
      parts.product = { name: product.name, ...(product.appearance ? { appearance: product.appearance } : {}), ...(photo ? { image: add(photo) } : {}) };
    }
    const set = setForBeat(sets, beat.setting);
    if (set) {
      const photo = set.imageAssetIds.find((id) => store.assets.get(id)?.state.state === "active");
      parts.set = { name: set.name, ...(photo ? { image: add(photo) } : {}), photo: isPhoto(store, photo) };
    }
    return buildProposal(context, {
      projectId: content.projectId,
      capability: references.length ? "image_edit" : "text_to_image",
      recipeId: input.recipeId,
      shot: parts,
      references,
      count: input.count ?? (content.mode === "quick" ? QUICK_AD.frameCount : 4),
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
      shot: { kind: "refine", instruction: input.instruction, subject: asset.kind === "sheet" ? "sheet" : "still" },
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
    "Propose a clip for one beat from its approved still (the first frame). Talking beats carry the spoken line in quotes for synchronized audio; b-roll is ambient sound only. With mode first_last, the clip also ends on lastAssetId, which must be an approved still in this content piece or the project's reference sheet; use it only when that ending still was composed for the same shot, since unrelated endpoints produce a dissolve. With mode speech, a talking beat's approved voice take drives the clip (lip sync, speech_to_video, 4.8 s at most), so every talking beat can share one cloned voice.",
  input: z
    .object({
      contentId: IdSchema,
      beatIndex: z.number().int().positive(),
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(1),
      mode: z.enum(["start", "first_last", "speech"]).default("start").describe("start animates from the approved still; first_last also lands on an ending frame; speech lip-syncs the beat's approved voice take."),
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
    const speech = input.mode === "speech";
    if (speech && beat.type !== "talking") {
      fail("invalid", `Beat ${beat.index} is ${beat.type === "broll" ? "b-roll" : "a text card"}; its line is a voice-over mixed in at export, not lip-synced. Use mode start.`);
    }
    if (!shot || shot.still.state !== "approved") fail("invalid", `Approve a still for beat ${input.beatIndex} before making its clip.`);
    if (input.mode !== "first_last" && input.lastAssetId) fail("invalid", "An ending frame needs mode first_last.");
    const firstLast = input.mode === "first_last";
    const lastAssetId = firstLast
      ? endingFrame(store, content, input.lastAssetId ?? fail("invalid", "Choose the ending frame (lastAssetId) for a first-and-last clip."), shot.still.assetId)
      : undefined;
    let take: Asset | undefined;
    if (speech) {
      if (shot.voice.state !== "approved") fail("invalid", `Approve a voice take for beat ${beat.index} first (generate_voice_over), then make the clip from it.`);
      take = store.assets.getRequired(shot.voice.assetId);
      if (take.kind !== "audio" || !take.audio) fail("invalid", "The approved voice take is not an audio recording.");
    }
    const cast = projectCast(store, content.projectId);
    // A lip-synced clip lasts as long as its take plus a breath; the recipe caps it at one chunk.
    const durationSeconds = take?.audio ? Math.min(beat.durationSeconds, take.audio.durationSeconds + 0.4) : beat.durationSeconds;
    const person = cast.character?.item.bible;
    return buildProposal(context, {
      projectId: content.projectId,
      capability: firstLast ? "first_last_to_video" : speech ? "speech_to_video" : "image_to_video",
      recipeId: input.recipeId,
      shot: {
        kind: "clip",
        beat,
        mode: input.mode,
        durationSeconds,
        ...(person
          ? {
              character: {
                name: person.name,
                visualCore: person.visualCore,
                wardrobe: cast.character!.link.wardrobe ?? person.wardrobeDefaults[0] ?? "the outfit shown in the start image",
                voice: `a natural voice, ${inline(person.voice.pace)}`.slice(0, 200),
              },
            }
          : {}),
        ...(cast.product ? { product: { name: cast.product.name, ...(cast.product.appearance ? { appearance: cast.product.appearance } : {}) } } : {}),
      },
      references: lastAssetId
        ? [
            { role: "first", assetId: shot.still.assetId },
            { role: "last", assetId: lastAssetId },
          ]
        : take
          ? [
              { role: "image1", assetId: shot.still.assetId },
              { role: "voice", assetId: take.id },
            ]
          : [{ role: "image1", assetId: shot.still.assetId }],
      count: input.count,
      target: { kind: "shot", contentId: content.id, beatIndex: beat.index, slot: "clip" },
      aspectRatio: "9:16",
      durationSeconds,
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
  /** Set on a blocked result when the run would cross this month's remaining budget. */
  budget: BudgetCrossingSchema.nullable().default(null),
});

export const submitProposal = defineTool({
  name: "submit_proposal",
  description:
    "Internal: submit an approved proposal as one generation job per candidate. Called by the UI gate after the user approves, or by auto-approve under the budget; the assistant never calls it on its own. A proposal whose cost would cross this month's remaining budget is blocked as a whole, with the spent, remaining, and cost figures. Submitting the same proposal again never runs it twice.",
  input: z
    .object({
      proposal: GenerationProposalSchema,
      confirmUnquoted: z.boolean().default(false).describe("The user accepted a reservation for a recipe without a live price."),
      wait: z.boolean().default(false).describe("Wait for every candidate to finish instead of returning once submitted."),
    })
    .strict(),
  output: z.object({
    results: z.array(SubmitResultSchema),
    /** The share of this month's budget in use after submitting: 0, 50, 80, or 100 percent. */
    warning: SpendWarningSchema,
  }),
  run: async (context, input) => {
    let { proposal } = input;
    // A prompt edited on the card is user input: bounded and checked here, whatever the client sent,
    // and what runs is the trimmed text.
    if (proposal.promptEdited) {
      const edited = EditedPromptSchema.safeParse(proposal.prompt);
      if (!edited.success) fail("invalid", edited.error.issues[0]?.message ?? "The edited prompt is not valid.");
      proposal = { ...proposal, prompt: edited.data };
    }
    const deps = runDeps(context);
    const request = await proposalRequest(context, proposal);
    const results: z.input<typeof SubmitResultSchema>[] = [];
    // The candidates not yet admitted are checked as a whole first, so a proposal that would cross
    // the budget starts none of them. The amount is the executor's own estimate, never the
    // client-supplied `proposal.estimate`; each candidate is still gated on its own estimate below.
    const candidates = Array.from({ length: proposal.count }, (_, index) => candidateRequestId(proposal.id, index));
    const fresh = candidates.filter((requestId) => !context.store.jobs.getByRequest(requestId));
    const executor = deps.executors.forRecipe(request.recipe);
    const before = spendPolicy(deps);
    if (executor && fresh.length && before.ceilingUsd > 0) {
      const estimate = await executor.estimate({ requestId: fresh[0], projectId: proposal.projectId, recipe: request.recipe, input: request.input });
      const unitUsd = reservationUsd(estimate, request.recipe);
      const crossing = unitUsd === undefined ? null : budgetCrossing(before, unitUsd * fresh.length);
      if (crossing) {
        // Candidates admitted by an earlier submission are reported as they are, so the card never
        // says nothing ran when some did.
        for (const requestId of candidates) {
          const job = context.store.jobs.getByRequest(requestId);
          if (!job) continue;
          results.push({ requestId, outcome: "existing", job, assetIds: job.status === "completed" ? job.outputs : [], message: null, reserveUsd: job.reservedUsd, budget: null });
        }
        results.push({ requestId: fresh[0], outcome: "blocked", job: null, assetIds: [], message: describeCrossing(crossing), reserveUsd: null, budget: crossing });
        return { results, warning: before.warning };
      }
    }
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
          budget: started.kind === "blocked" ? (started.budget ?? null) : null,
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
    return { results, warning: spendPolicy(deps).warning };
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
    "List recipes that can run a capability, verified first and mocks last, with whether each is verified on a real account, uses open weights, can run with the keys and backends configured now, and which backend it would run on (runsOn; backendNote says why one cannot run or that it falls back to Comfy Cloud).",
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
        /** The backend it would run on now (Settings, Backends), when backends decide it. */
        runsOn: z.string().nullable(),
        /** Why it cannot run, or that it falls back to Comfy Cloud, in words for the person. */
        backendNote: z.string().nullable(),
      }),
    ),
  }),
  run: async (context, input) => {
    const recipes = context.generation ? await context.generation.recipes() : await defaultRecipes();
    const listed = input.capability
      ? recipesFor(recipes, input.capability)
      : [...recipes].sort((a, b) => Number(a.kind === "mock") - Number(b.kind === "mock") || Number(!a.verified) - Number(!b.verified));
    const routing = context.generation?.routing?.();
    return {
      recipes: listed.map((recipe) => {
        const placement = routing ? placeRecipe(recipe, routing) : undefined;
        return {
        id: recipe.id,
        title: recipe.title,
        capability: recipe.capability,
        kind: recipe.kind,
        verified: recipe.verified !== null,
        verifiedOn: recipe.verified,
        openWeights: recipe.openWeights,
        costHint: recipe.costHint,
        available: placement ? placement.ok : context.generation ? !!context.generation.executors.forRecipe(recipe) : recipe.kind === "mock",
        runsOn: placement?.ok ? (placement.backend?.label ?? null) : null,
        backendNote: placement ? (placement.ok ? placementNote(placement) || null : placement.reason) : null,
        };
      }),
    };
  },
});
