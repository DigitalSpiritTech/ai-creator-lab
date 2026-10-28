/**
 * Voice tools: the voice sample a character's voice-overs are cloned from, and the voice-over
 * proposal for one beat. The clip for a b-roll beat or text card is ambient only; its line is
 * read in the creator's voice and mixed in at export.
 * @packageDocumentation
 */
import { z } from "zod";
import type { Asset } from "@/lib/domain/asset";
import { IdSchema, RecipeIdSchema } from "@/lib/domain/common";
import type { ContentPiece } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import { GenerationProposalSchema } from "@/lib/domain/job";
import { type CharacterItem, CharacterItemSchema, setCharacterReference } from "@/lib/domain/library";
import type { Script } from "@/lib/domain/script";
import { extractVoiceSample } from "@/server/media/audio";
import { buildProposal } from "@/server/tools/proposals";
import { type ToolContext, defineTool } from "@/server/tools/registry";
import { requireActiveAsset } from "@/server/tools/shared";
import type { Store } from "@/server/store";

function linkedCharacter(store: Store, projectId: string, characterId?: string): CharacterItem {
  for (const link of store.library.listLinks(projectId)) {
    if (link.kind !== "character" || (characterId && link.itemId !== characterId)) continue;
    const item = store.library.get(link.itemId);
    if (item && item.kind === "character" && !item.archived) return item;
  }
  return fail("not_found", characterId ? "This character is not linked to the project." : "Link or create a character for this project first.");
}

function latestAd(store: Store, projectId: string, contentId?: string): ContentPiece {
  if (contentId) return store.content.getRequired(contentId);
  const content = store.content.listByProject(projectId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return content ?? fail("not_found", "This project has no Ad yet. Save a script and plan its shots first.");
}

function scriptOf(store: Store, content: ContentPiece): Script {
  return store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This content piece's script version is missing.");
}

/** The first approved talking clip in cut order, with its spoken line. */
function approvedTalkingClip(store: Store, projectId: string): { clip: Asset; line: string } | undefined {
  for (const content of store.content.listByProject(projectId).sort((a, b) => b.updatedAt - a.updatedAt)) {
    const script = store.scripts.get(content.scriptId, content.scriptVersion);
    if (!script) continue;
    for (const shotId of content.cut.order) {
      const shot = content.shots.find((entry) => entry.id === shotId);
      const beat = shot && script.beats[shot.beatIndex - 1];
      if (!shot || !beat || beat.type !== "talking" || shot.clip.state !== "approved") continue;
      const clip = store.assets.get(shot.clip.assetId);
      if (clip && clip.kind === "video" && clip.state.state === "active" && clip.video?.hasAudio) return { clip, line: beat.spokenLine };
    }
  }
  return undefined;
}

/**
 * The character's voice sample, taking it from the first approved talking clip when none is set.
 * Returns the sample and whether the character was updated.
 */
export async function ensureVoiceSample(
  context: ToolContext,
  projectId: string,
  character: CharacterItem,
): Promise<{ sample: Asset; character: CharacterItem; taken: boolean }> {
  const { store } = context;
  const current = character.bible.references.voiceAssetId ? store.assets.get(character.bible.references.voiceAssetId) : undefined;
  if (current && current.state.state === "active" && current.kind === "audio") return { sample: current, character, taken: false };
  const found = approvedTalkingClip(store, projectId);
  if (!found) {
    fail(
      "invalid",
      `${character.bible.name} has no voice sample yet. Approve a talking clip (its audio becomes the sample), or upload a recording of the creator's voice on the Assets tab.`,
    );
  }
  const sample = await extractVoiceSample(store, found.clip, found.line, { now: context.now(), newId: context.newId });
  const updated = store.library.update(setCharacterReference(character, "voice", sample, context.now())) as CharacterItem;
  return { sample, character: updated, taken: true };
}

export const extractVoiceSampleTool = defineTool({
  name: "extract_voice_sample",
  description:
    "Set a character's voice sample, which every voice-over is cloned from: with clipAssetId, that clip's audio track; without it, the first approved talking clip's. Uploaded recordings are set with select_reference slot voice instead. Example: the user approved beat 1's talking clip and asks for the b-roll voice-overs.",
  input: z
    .object({
      projectId: IdSchema,
      characterId: IdSchema.optional(),
      clipAssetId: IdSchema.optional().describe("A clip with sound from this project; default: the first approved talking clip."),
    })
    .strict(),
  output: z.object({ character: CharacterItemSchema, sample: z.object({ assetId: IdSchema, durationSeconds: z.number(), transcript: z.string().nullable() }) }),
  run: async (context, input) => {
    const { store } = context;
    const character = linkedCharacter(store, input.projectId, input.characterId);
    let sample: Asset;
    let updated: CharacterItem;
    if (input.clipAssetId) {
      const clip = requireActiveAsset(store, input.clipAssetId, ["video"]);
      if (clip.projectId !== input.projectId) fail("invalid", "Choose a clip from this project.");
      const line = clipLine(store, input.projectId, clip.id);
      sample = await extractVoiceSample(store, clip, line, { now: context.now(), newId: context.newId });
      updated = store.library.update(setCharacterReference(character, "voice", sample, context.now())) as CharacterItem;
    } else {
      const found = approvedTalkingClip(store, input.projectId) ?? fail("invalid", "No talking clip is approved yet. Approve one, or name a clip with clipAssetId.");
      sample = await extractVoiceSample(store, found.clip, found.line, { now: context.now(), newId: context.newId });
      updated = store.library.update(setCharacterReference(character, "voice", sample, context.now())) as CharacterItem;
    }
    return { character: updated, sample: { assetId: sample.id, durationSeconds: sample.audio?.durationSeconds ?? 0, transcript: sample.audio?.transcript ?? null } };
  },
});

/** The spoken line of the beat a clip is approved for, when it is a talking beat. */
function clipLine(store: Store, projectId: string, clipAssetId: string): string | undefined {
  for (const content of store.content.listByProject(projectId)) {
    const script = store.scripts.get(content.scriptId, content.scriptVersion);
    for (const shot of content.shots) {
      const beat = script?.beats[shot.beatIndex - 1];
      if (shot.clip.state !== "empty" && shot.clip.candidateIds.includes(clipAssetId) && beat?.type === "talking") return beat.spokenLine;
    }
  }
  return undefined;
}

export const generateVoiceOver = defineTool({
  name: "generate_voice_over",
  description:
    "Propose a voice take for one beat: its line read in the creator's cloned voice (from the character's voice sample, taken from the first approved talking clip when none is set). On a b-roll or text card beat the approved take is the voice-over the export mixes over the clip. On a talking beat it is the speech a lip-synced clip is made from (generate_clip with mode speech), for one voice across the whole ad. Nothing is generated until the user approves the proposal. Example: beat 2 is b-roll with a line and has no approved voice-over.",
  input: z
    .object({
      projectId: IdSchema,
      contentId: IdSchema.optional().describe("Default: the project's newest Ad."),
      beatIndex: z.number().int().positive(),
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(1),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: async (context, input) => {
    const { store } = context;
    const content = latestAd(store, input.projectId, input.contentId);
    if (content.projectId !== input.projectId) fail("invalid", "This Ad belongs to another project.");
    const script = scriptOf(store, content);
    const beat = script.beats[input.beatIndex - 1] ?? fail("not_found", `Beat ${input.beatIndex} is not in the script.`);
    if (!beat.spokenLine.trim()) fail("invalid", `Beat ${beat.index} has no line. Add a line to the script first.`);
    const character = linkedCharacter(store, input.projectId);
    const { sample } = await ensureVoiceSample(context, input.projectId, character);
    const transcript = sample.audio?.transcript?.trim();
    return buildProposal(context, {
      projectId: input.projectId,
      capability: "text_to_speech",
      recipeId: input.recipeId,
      prompt: beat.spokenLine.trim(),
      references: [{ role: "voice", assetId: sample.id }],
      count: input.count,
      target: { kind: "shot", contentId: content.id, beatIndex: beat.index, slot: "voice" },
      durationSeconds: beat.durationSeconds,
      ...(transcript ? { slots: { refText: transcript } } : {}),
    });
  },
});
