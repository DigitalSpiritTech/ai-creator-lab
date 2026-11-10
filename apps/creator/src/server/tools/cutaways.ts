/**
 * Take-then-cutaways tools (v0.2 F5): `generate_take` proposes the Ad's full talking take,
 * `transcribe_take` proposes its transcription with word timestamps (both spend, so both return a
 * proposal for the gate), and `save_edl` drafts the edit decision list from the transcript or saves
 * an edit of it as a new document version. `assemble_ad` with strategy `take_cutaways` renders it.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, RecipeIdSchema } from "@creator-lab/core/domain/common";
import { ContentPieceSchema, setEdl } from "@creator-lab/core/domain/content";
import { EdlCueSchema, EdlSchema, EdlWindowSchema, reviseEdl } from "@creator-lab/core/domain/edl";
import { sameContent } from "@creator-lab/core/domain/document";
import { fail } from "@creator-lab/core/domain/failure";
import { GenerationProposalSchema } from "@creator-lab/core/domain/job";
import { inline } from "@creator-lab/recipes/prompts";
import { PLANNED_TRANSCRIPTION_RECIPES, plannedRecipe } from "@creator-lab/recipes/transcription";
import { approvedTake, draftEdlFor } from "@/server/assembly/edl";
import { recordDocument } from "@/server/tools/documents";
import { projectCast } from "@/server/tools/generation";
import { buildProposal } from "@/server/tools/proposals";
import { defineTool, requireGeneration } from "@/server/tools/registry";

/** The longest take a proposal asks for; the beats' lengths add up to it. */
export const MAX_TAKE_SECONDS = 60;

export const generateTake = defineTool({
  name: "generate_take",
  description:
    "Propose the Ad's full talking take for a take-then-cutaways export: one continuous clip from the first talking beat's approved still in which the creator says every beat's line in order, as long as the beats added up (60 s at most). B-roll is cut over some lines later from the edit decision list; the take's sound is kept untouched. The take lands in the Ad's take slot; approve one with approve kind take. Nothing runs until the proposal is accepted.",
  input: z
    .object({
      contentId: IdSchema,
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(2).default(1),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: (context, input) => {
    const { store } = context;
    const content = store.content.getRequired(input.contentId);
    const script = store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This Ad's script version is missing.");
    const opening = script.beats.find((beat) => beat.type === "talking") ?? fail("invalid", "A take needs a talking beat: the creator says the script on camera, and b-roll is cut in over it.");
    const shot = content.shots[opening.index - 1];
    if (!shot || shot.still.state !== "approved") fail("invalid", `Approve a still for beat ${opening.index}, the first talking beat; the take starts from it.`);
    const lines = script.beats.filter((beat) => beat.spokenLine.trim()).map((beat) => ({ beatIndex: beat.index, text: beat.spokenLine.trim() }));
    const durationSeconds = Math.min(MAX_TAKE_SECONDS, script.beats.reduce((sum, beat) => sum + beat.durationSeconds, 0));
    const cast = projectCast(store, content.projectId);
    const person = cast.character?.item.bible;
    return buildProposal(context, {
      projectId: content.projectId,
      capability: "image_to_video",
      recipeId: input.recipeId,
      shot: {
        kind: "take",
        visual: opening.visual,
        setting: opening.setting,
        lines,
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
      references: [{ role: "image1", assetId: shot.still.assetId }],
      count: input.count,
      target: { kind: "take", contentId: content.id, slot: "clip" },
      aspectRatio: "9:16",
      durationSeconds,
    });
  },
});

/** Why no transcription recipe can run, naming what each planned one is waiting for. */
function noTranscriptionRecipe(): never {
  const pending = PLANNED_TRANSCRIPTION_RECIPES.map((recipe) => `${recipe.title} is not ready yet (${recipe.pending.split(". ")[0]}.)`).join(" ");
  return fail("invalid", `No transcription recipe can run here. ${pending}`);
}

export const transcribeTake = defineTool({
  name: "transcribe_take",
  description:
    "Propose a transcription of the Ad's approved take with word timestamps (speech to text), so the beats can be aligned to times and the edit decision list drafted (save_edl). The script's lines go with it as vocabulary, so names and claims are spelled the script's way. Spends like any generation: returns a proposal for the gate. Whisper on Comfy Router and open-weights Whisper on Comfy Cloud are planned but not verified yet; list_recipes shows what each is waiting for.",
  input: z.object({ contentId: IdSchema, recipeId: RecipeIdSchema.optional() }).strict(),
  output: GenerationProposalSchema,
  run: async (context, input) => {
    const { store } = context;
    if (input.recipeId) {
      const planned = plannedRecipe(input.recipeId);
      if (planned) fail("invalid", `${planned.title} cannot run yet: ${planned.pending}`);
    }
    const recipes = await requireGeneration(context).recipes();
    if (!input.recipeId && !recipes.some((recipe) => recipe.capability === "speech_to_text")) noTranscriptionRecipe();
    const content = store.content.getRequired(input.contentId);
    const take = approvedTake(store, content);
    if (!take.video?.hasAudio) fail("invalid", "The approved take has no sound to transcribe.");
    const script = store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This Ad's script version is missing.");
    const words = script.beats.map((beat) => beat.spokenLine.trim()).filter(Boolean).join(" ");
    const vocabulary = (words || script.title).slice(0, 1000);
    return buildProposal(context, {
      projectId: content.projectId,
      capability: "speech_to_text",
      recipeId: input.recipeId,
      shot: { kind: "transcript", vocabulary },
      references: [{ role: "take", assetId: take.id }],
      count: 1,
      target: { kind: "take", contentId: content.id, slot: "transcript" },
    });
  },
});

export const saveEdl = defineTool({
  name: "save_edl",
  description:
    "Save the Ad's edit decision list (EDL), a document in the artifact panel. With draft true, or when the Ad has none yet and no windows or captions are given, it is drafted from the newest transcript of the approved take: each b-roll or text card beat whose line is heard gets a window from its first word to the next line's first word, and each beat's on-screen text becomes a caption over the same stretch. With windows and/or captions, those replace the current ones (times in seconds on the take; windows show b-roll or text card beats, at least 0.5 s, in order, never overlapping). Every save is a new version; re-export with assemble_ad strategy take_cutaways. Nothing is generated.",
  input: z
    .object({
      contentId: IdSchema,
      draft: z.boolean().default(false).describe("Draft it again from the take's transcript, replacing the current windows and captions."),
      windows: z.array(EdlWindowSchema).max(8).optional().describe("The b-roll windows: { beatIndex, start, end } in seconds on the take."),
      captions: z.array(EdlCueSchema).max(64).optional().describe("The captions: { start, end, text } in seconds on the take."),
    })
    .strict(),
  output: z.object({
    content: ContentPieceSchema,
    edl: EdlSchema,
    /** The saved version, or null when nothing changed. */
    version: z.number().int().positive().nullable(),
    /** Non-talking beats the draft could not place (no line, or a line the take never says). */
    unplaced: z.array(z.number().int().positive()),
  }),
  run: async (context, input) => {
    const { store, now } = context;
    const before = store.content.getRequired(input.contentId);
    const editing = input.windows !== undefined || input.captions !== undefined;
    if (input.draft && editing) fail("invalid", "Draft the list or edit it, not both in one save.");
    const drafted = input.draft || (!editing && !before.edl) ? await draftEdlFor(store, before) : null;
    return store.transaction(() => {
      const content = store.content.getRequired(input.contentId);
      if (content.revision !== before.revision && drafted) fail("conflict", "The Ad changed while the list was being drafted. Save again.");
      const script = store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This Ad's script version is missing.");
      const current = content.edl;
      if (!drafted && !current) fail("invalid", "This Ad has no edit decision list yet. Draft it first (draft true).");
      const edl = drafted ? reviseEdl(drafted.edl, {}, script) : reviseEdl(current!, { windows: input.windows, captions: input.captions }, script);
      if (current && sameContent(current, edl)) return { content, edl: current, version: null, unplaced: drafted?.unplaced ?? [] };
      const saved = store.content.update(setEdl(content, edl, now()));
      const document = recordDocument(context, "edl", saved.id, saved.edl!);
      return { content: saved, edl: saved.edl!, version: document?.version ?? null, unplaced: drafted?.unplaced ?? [] };
    });
  },
});
