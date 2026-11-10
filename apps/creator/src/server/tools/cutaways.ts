/**
 * Take-then-cutaways tools (v0.2 F5; "recording with cutaways" to the person): `generate_take`
 * proposes the Ad's full talking take,
 * `transcribe_take` proposes its transcription with word timestamps (both spend, so both return a
 * proposal for the gate), and `save_edl` drafts the edit decision list from the transcript or saves
 * an edit of it as a new document version. `assemble_ad` with strategy `take_cutaways` renders it.
 * @packageDocumentation
 */
import { z } from "zod";
import type { Recipe } from "@creator-lab/core/catalog";
import { IdSchema, RecipeIdSchema } from "@creator-lab/core/domain/common";
import { ContentPieceSchema, setEdl } from "@creator-lab/core/domain/content";
import { EdlCueSchema, EdlSchema, EdlWindowSchema, MAX_TAKE_SECONDS, estimatedBeats, reviseEdl } from "@creator-lab/core/domain/edl";
import { sameContent } from "@creator-lab/core/domain/document";
import { fail } from "@creator-lab/core/domain/failure";
import { GenerationProposalSchema } from "@creator-lab/core/domain/job";
import { recipesFor } from "@creator-lab/recipes/defaults";
import { inline } from "@creator-lab/recipes/prompts";
import { PLANNED_TRANSCRIPTION_RECIPES, plannedRecipe } from "@creator-lab/recipes/transcription";
import { describeDurations } from "@creator-lab/executors/router-body";
import { approvedTake, draftEdlFor } from "@/server/assembly/edl";
import { recordDocument } from "@/server/tools/documents";
import { projectCast } from "@/server/tools/generation";
import { type ProposalSpec, buildProposal, referenceRange } from "@/server/tools/proposals";
import { defineTool, requireGeneration } from "@/server/tools/registry";

/** The fps a workflow's length rule counts frames at. */
function workflowFps(recipe: Extract<Recipe, { kind: "workflow" }>): number {
  return recipe.sidecar.limits.fps ?? recipe.limits.fps ?? 24;
}

/**
 * Whether a video recipe makes one clip this long: a Router model from its list of lengths, a
 * workflow up to its longest single chunk (most have none), the mock always.
 */
export function makesLength(recipe: Recipe, seconds: number): boolean {
  if (recipe.kind === "router") return !recipe.limits.durations || recipe.limits.durations.includes(seconds);
  if (recipe.kind === "workflow") {
    const max = recipe.sidecar.limits.length?.max;
    return max === undefined || Math.round(seconds * workflowFps(recipe)) <= max;
  }
  return true;
}

function lengthsOf(recipe: Recipe): string {
  if (recipe.kind === "router" && recipe.limits.durations) return describeDurations(recipe.limits.durations);
  if (recipe.kind === "workflow" && recipe.sidecar.limits.length?.max) return `up to ${(recipe.sidecar.limits.length.max / workflowFps(recipe)).toFixed(1)} s`;
  return "any length";
}

export const generateTake = defineTool({
  name: "generate_take",
  description:
    "Propose the Ad's full talking recording for a recording-with-cutaways export: one continuous clip from the first talking beat's approved still in which the creator says every beat's line in order, as long as the beats added up (60 s at most). Without a recipeId it picks a recipe that makes a clip that long; a recipe that cannot is refused with the ones that can. B-roll is cut over some lines later from the edit decision list; the recording's sound is kept untouched. It lands in the Ad's take slot; approve one with approve kind take. Nothing runs until the proposal is accepted.",
  input: z
    .object({
      contentId: IdSchema,
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(2).default(1),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: async (context, input) => {
    const { store } = context;
    const generation = requireGeneration(context);
    const content = store.content.getRequired(input.contentId);
    const script = store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This Ad's script version is missing.");
    const opening = script.beats.find((beat) => beat.type === "talking") ?? fail("invalid", "A talking recording needs a talking beat: the creator says the script on camera, and b-roll is cut in over it.");
    const shot = content.shots[opening.index - 1];
    if (!shot || shot.still.state !== "approved") fail("invalid", `Approve a still for beat ${opening.index}, the first talking beat; the talking recording starts from it.`);
    const lines = script.beats.filter((beat) => beat.spokenLine.trim()).map((beat) => ({ beatIndex: beat.index, text: beat.spokenLine.trim() }));
    const durationSeconds = Math.min(MAX_TAKE_SECONDS, script.beats.reduce((sum, beat) => sum + beat.durationSeconds, 0));
    const stillId = shot.still.assetId;
    const cast = projectCast(store, content.projectId);
    const person = cast.character?.item.bible;
    const spec = (recipeId: string | undefined): ProposalSpec => ({
      projectId: content.projectId,
      capability: "image_to_video",
      recipeId,
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
      references: [{ role: "image1", assetId: stillId }],
      count: input.count,
      target: { kind: "take", contentId: content.id, slot: "clip" },
      aspectRatio: "9:16",
      durationSeconds,
    });
    const recipes = await generation.recipes();
    const proposal = await buildProposal(context, spec(input.recipeId));
    const picked = recipes.find((recipe) => recipe.id === proposal.recipeId);
    if (!picked || makesLength(picked, durationSeconds)) return proposal;
    const fitting = recipesFor(recipes, "image_to_video", generation.routing?.()).filter((recipe) => {
      const [min, max] = referenceRange(recipe);
      return makesLength(recipe, durationSeconds) && !!generation.executors.forRecipe(recipe) && min <= 1 && max >= 1;
    });
    if (!input.recipeId && fitting[0]) return buildProposal(context, spec(fitting[0].id));
    const others = fitting.length
      ? ` Recipes that make a ${durationSeconds} s clip here: ${fitting.map((recipe) => `${recipe.title} (${recipe.id})`).join(", ")}. Pass one as recipeId.`
      : ` No recipe configured here makes a single ${durationSeconds} s clip; shorten the beats to a length one of them makes.`;
    return fail("invalid", `${picked.title} makes clips of ${lengthsOf(picked)}; this recording is ${durationSeconds} s.${others}`);
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
    "Propose a transcription of the Ad's approved talking recording with word timestamps (speech to text), so the beats can be aligned to times and the edit decision list drafted (save_edl). The script's lines go with it as vocabulary, so names and claims are spelled the script's way. Spends like any generation: returns a proposal for the gate. Whisper on Comfy Router and open-weights Whisper on Comfy Cloud are planned but not verified yet; list_recipes shows what each is waiting for.",
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
    if (!take.video?.hasAudio) fail("invalid", "The approved recording has no sound to transcribe.");
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
    "Save the Ad's edit decision list (EDL), a document in the artifact panel. With draft true, or when the Ad has none yet and no windows or captions are given, it is drafted from the newest transcript of the approved talking recording: each b-roll or text card beat whose line is heard gets a window from its first word to the next line's first word, and each beat's on-screen text becomes a caption over the same stretch. With windows and/or captions, those replace the current ones (times in seconds on the recording; windows show b-roll or text card beats, at least 0.5 s, in order, never overlapping). Every save is a new version; re-export with assemble_ad strategy take_cutaways. Nothing is generated.",
  input: z
    .object({
      contentId: IdSchema,
      draft: z.boolean().default(false).describe("Draft it again from the recording's transcript, replacing the current windows and captions."),
      windows: z.array(EdlWindowSchema).max(8).optional().describe("The b-roll windows: { beatIndex, start, end } in seconds on the recording."),
      captions: z.array(EdlCueSchema).max(64).optional().describe("The captions: { start, end, text } in seconds on the recording."),
    })
    .strict(),
  output: z.object({
    content: ContentPieceSchema,
    edl: EdlSchema,
    /** The saved version, or null when nothing changed. */
    version: z.number().int().positive().nullable(),
    /** Non-talking beats the draft could not place (no line, or a line the recording never says). */
    unplaced: z.array(z.number().int().positive()),
    /** Beats placed by estimate: none of their words was heard, so they sit in the gap their neighbours leave. */
    estimated: z.array(z.number().int().positive()),
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
      if (!drafted && current) {
        // Editing a list for another recording, or an older script, would save times that match nothing.
        if (content.take.state !== "approved" || current.take.assetId !== content.take.assetId) {
          fail("conflict", "This edit decision list was drafted for another recording. Draft it again from the approved recording's transcript (draft true), then edit it.");
        }
        if (current.scriptVersion < content.scriptVersion) {
          fail("conflict", "The script changed since this edit decision list was drafted. Draft it again (draft true), then edit it.");
        }
      }
      const edl = drafted ? reviseEdl(drafted.edl, {}, script) : reviseEdl(current!, { windows: input.windows, captions: input.captions }, script);
      const unplaced = drafted?.unplaced ?? [];
      if (current && sameContent(current, edl)) return { content, edl: current, version: null, unplaced, estimated: estimatedBeats(current) };
      const saved = store.content.update(setEdl(content, edl, now()));
      const document = recordDocument(context, "edl", saved.id, saved.edl!);
      return { content: saved, edl: saved.edl!, version: document?.version ?? null, unplaced, estimated: estimatedBeats(saved.edl!) };
    });
  },
});
