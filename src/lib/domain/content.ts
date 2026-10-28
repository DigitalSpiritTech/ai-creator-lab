/**
 * Content pieces (the Ad), their shots, the cut, and export records.
 * A shot is one beat's production: still candidates and approval, then clip candidates and approval.
 * @packageDocumentation
 */
import { z } from "zod";
import type { Asset } from "@/lib/domain/asset";
import {
  IdSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampSchema,
  nextRevision,
  text,
} from "@/lib/domain/common";
import { fail } from "@/lib/domain/failure";
import type { Script, ScriptChange } from "@/lib/domain/script";

/** `voice` holds the beat's voice-over audio; it stays empty on beats without a line. */
export const SlotKindSchema = z.enum(["still", "clip", "voice"]);
export type SlotKind = z.infer<typeof SlotKindSchema>;

const candidateIds = z.array(IdSchema).min(1).max(64);

export const SlotSchema = z
  .discriminatedUnion("state", [
    z.object({ state: z.literal("empty") }).strict(),
    z.object({ state: z.literal("open"), candidateIds, selectedId: IdSchema.nullable() }).strict(),
    z.object({ state: z.literal("approved"), candidateIds, assetId: IdSchema, approvedAt: TimestampSchema }).strict(),
  ])
  .refine((slot) => {
    if (slot.state === "open") return slot.selectedId === null || slot.candidateIds.includes(slot.selectedId);
    if (slot.state === "approved") return slot.candidateIds.includes(slot.assetId);
    return true;
  }, "Selections and approvals must be one of the slot's candidates.");
export type Slot = z.infer<typeof SlotSchema>;

export const ShotSchema = z
  .object({
    id: IdSchema,
    beatIndex: z.number().int().positive(),
    still: SlotSchema,
    clip: SlotSchema,
    voice: SlotSchema.default({ state: "empty" }),
    brokenAssetIds: z.array(IdSchema).default([]),
  })
  .strict();
export type Shot = z.infer<typeof ShotSchema>;

export const CutSchema = z
  .object({
    order: z.array(IdSchema),
    mute: z.boolean(),
    captions: z.boolean(),
  })
  .strict();
export type Cut = z.infer<typeof CutSchema>;

export const ContentPieceSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    type: z.literal("ad"),
    title: text(120),
    scriptId: IdSchema,
    scriptVersion: z.number().int().positive(),
    shots: z.array(ShotSchema).max(8),
    cut: CutSchema,
    revision: RevisionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (content) => content.shots.every((shot, position) => shot.beatIndex === position + 1),
    "Shots follow the script's beats in order.",
  )
  .refine((content) => {
    const ids = content.shots.map((shot) => shot.id);
    return content.cut.order.length === ids.length && content.cut.order.every((id) => ids.includes(id));
  }, "The cut orders every shot exactly once.");
export type ContentPiece = z.infer<typeof ContentPieceSchema>;

export const ExportSourceSchema = z
  .object({
    shotId: IdSchema,
    beatIndex: z.number().int().positive(),
    assetId: IdSchema,
    sha256: Sha256Schema,
    /** Segment length in the export: the clip's length (or the beat's, for a still) rounded to whole frames. */
    durationSeconds: z.number().positive().max(60),
    onScreenText: z.string().max(80),
    /** The approved voice-over take mixed over this segment, when the beat has one. */
    voice: z.object({ assetId: IdSchema, sha256: Sha256Schema, durationSeconds: z.number().positive() }).strict().optional(),
  })
  .strict();
export type ExportSource = z.infer<typeof ExportSourceSchema>;

const exportBase = {
  id: IdSchema,
  contentId: IdSchema,
  projectId: IdSchema,
  contentRevision: RevisionSchema,
  scriptVersion: z.number().int().positive(),
  options: z.object({ mute: z.boolean(), captions: z.boolean() }).strict(),
  sources: z.array(ExportSourceSchema).min(1).max(8),
  brokenAssetIds: z.array(IdSchema).default([]),
  createdAt: TimestampSchema,
};

export const ExportRecordSchema = z.discriminatedUnion("status", [
  z.object({ ...exportBase, status: z.literal("rendering") }).strict(),
  z
    .object({
      ...exportBase,
      status: z.literal("completed"),
      assetId: IdSchema,
      sha256: Sha256Schema,
      durationSeconds: z.number().positive(),
      /** The ffmpeg graph and encoder settings, summarized for the source record. */
      filterSummary: z.string().max(2000),
      completedAt: TimestampSchema,
    })
    .strict(),
  z.object({ ...exportBase, status: z.literal("failed"), error: text(500), failedAt: TimestampSchema }).strict(),
]);
export type ExportRecord = z.infer<typeof ExportRecordSchema>;

/** Every export is 1080 x 1920 at this frame rate. */
export const EXPORT_FPS = 24;
export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;

/** Rounds a length to whole frames at the export frame rate. */
export function wholeFrames(seconds: number): number {
  return Math.max(1, Math.round(seconds * EXPORT_FPS));
}

const EMPTY_SLOT: Slot = { state: "empty" };

/** Creates the Ad for a script version with one empty shot per beat, in beat order. */
export function planShots(
  id: string,
  script: Script,
  title: string,
  now: number,
  newId: () => string,
): ContentPiece {
  const shots = script.beats.map((beat) => ({
    id: newId(),
    beatIndex: beat.index,
    still: EMPTY_SLOT,
    clip: EMPTY_SLOT,
    voice: EMPTY_SLOT,
    brokenAssetIds: [],
  }));
  return ContentPieceSchema.parse({
    id,
    projectId: script.projectId,
    type: "ad",
    title,
    scriptId: script.id,
    scriptVersion: script.version,
    shots,
    cut: { order: shots.map((shot) => shot.id), mute: false, captions: true },
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}

function withdrawApproval(slot: Slot): Slot {
  return slot.state === "approved" ? { state: "open", candidateIds: slot.candidateIds, selectedId: null } : slot;
}

/**
 * Moves a content piece to a new script version. Only beats named in `change` lose approvals;
 * candidates are kept so the user can re-approve. Removed beats drop their shots; added beats get
 * empty shots. The cut keeps the user's order for surviving shots and appends new ones.
 */
export function syncShotsToScript(
  content: ContentPiece,
  script: Script,
  change: ScriptChange,
  now: number,
  newId: () => string,
): ContentPiece {
  if (script.id !== content.scriptId) fail("invalid", "This script belongs to another content piece.");
  if (script.version === content.scriptVersion) return content;
  const shots: Shot[] = script.beats.map((beat) => {
    const existing = content.shots.find((shot) => shot.beatIndex === beat.index);
    if (!existing) {
      return { id: newId(), beatIndex: beat.index, still: EMPTY_SLOT, clip: EMPTY_SLOT, voice: EMPTY_SLOT, brokenAssetIds: [] };
    }
    const still = change.stillInvalidated.includes(beat.index) ? withdrawApproval(existing.still) : existing.still;
    const clip = change.clipInvalidated.includes(beat.index) ? withdrawApproval(existing.clip) : existing.clip;
    const voice = change.voiceInvalidated.includes(beat.index) ? withdrawApproval(existing.voice) : existing.voice;
    return { ...existing, still, clip, voice };
  });
  const ids = shots.map((shot) => shot.id);
  const kept = content.cut.order.filter((id) => ids.includes(id));
  const appended = ids.filter((id) => !kept.includes(id));
  return ContentPieceSchema.parse({
    ...nextRevision(content, now),
    scriptVersion: script.version,
    shots,
    cut: { ...content.cut, order: [...kept, ...appended] },
  });
}

function findShot(content: ContentPiece, beatIndex: number): Shot {
  const shot = content.shots.find((candidate) => candidate.beatIndex === beatIndex);
  if (!shot) fail("not_found", `Beat ${beatIndex} has no shot in this content piece.`);
  return shot;
}

function replaceShot(content: ContentPiece, shot: Shot, now: number): ContentPiece {
  return ContentPieceSchema.parse({
    ...nextRevision(content, now),
    shots: content.shots.map((existing) => (existing.id === shot.id ? shot : existing)),
  });
}

/** Adds generated candidates to a shot's still or clip slot. Existing approvals stay. */
export function addCandidates(
  content: ContentPiece,
  beatIndex: number,
  slot: SlotKind,
  assetIds: string[],
  now: number,
): ContentPiece {
  const shot = findShot(content, beatIndex);
  const current = shot[slot];
  const before = current.state === "empty" ? [] : current.candidateIds;
  const added = assetIds.filter((id) => !before.includes(id));
  if (added.length === 0) return content;
  const candidateIds = [...before, ...added];
  const next: Slot =
    current.state === "approved"
      ? { ...current, candidateIds }
      : { state: "open", candidateIds, selectedId: current.state === "open" ? current.selectedId : null };
  return replaceShot(content, { ...shot, [slot]: next }, now);
}

/** Marks one candidate as the current pick without approving it. */
export function selectCandidate(
  content: ContentPiece,
  beatIndex: number,
  slot: SlotKind,
  assetId: string,
  now: number,
): ContentPiece {
  const shot = findShot(content, beatIndex);
  const current = shot[slot];
  if (current.state === "empty" || !current.candidateIds.includes(assetId)) {
    fail("invalid", "Choose one of this beat's candidates.");
  }
  if (current.state === "approved") {
    fail("conflict", "This beat already has an approved choice. Approve a different candidate to replace it.");
  }
  if (current.selectedId === assetId) return content;
  return replaceShot(content, { ...shot, [slot]: { ...current, selectedId: assetId } }, now);
}

/**
 * Approves one candidate for a beat and returns the remaining candidates so the caller can
 * archive them. A clip needs an approved still. Approving a different still withdraws the
 * clip approval, because that clip was made from the previous still.
 */
export function approveCandidate(
  content: ContentPiece,
  beatIndex: number,
  slot: SlotKind,
  assetId: string,
  now: number,
): { content: ContentPiece; siblingIds: string[] } {
  const shot = findShot(content, beatIndex);
  const current = shot[slot];
  if (current.state === "empty" || !current.candidateIds.includes(assetId)) {
    fail("invalid", "Choose one of this beat's candidates.");
  }
  if (slot === "clip" && shot.still.state !== "approved") {
    fail("invalid", "Approve this beat's still before approving a clip.");
  }
  const siblingIds = current.candidateIds.filter((id) => id !== assetId);
  if (current.state === "approved" && current.assetId === assetId) return { content, siblingIds };
  const approved: Slot = { state: "approved", candidateIds: current.candidateIds, assetId, approvedAt: now };
  const next: Shot =
    slot === "still"
      ? { ...shot, still: approved, clip: current.state === "approved" ? withdrawApproval(shot.clip) : shot.clip }
      : { ...shot, [slot]: approved };
  return { content: replaceShot(content, next, now), siblingIds };
}

export const CutPatchSchema = z
  .object({
    order: z.array(IdSchema).optional(),
    mute: z.boolean().optional(),
    captions: z.boolean().optional(),
  })
  .strict();
export type CutPatch = z.infer<typeof CutPatchSchema>;

export function updateCut(content: ContentPiece, patch: CutPatch, now: number): ContentPiece {
  const ids = content.shots.map((shot) => shot.id);
  const order = patch.order ?? content.cut.order;
  if (order.length !== ids.length || new Set(order).size !== ids.length || !order.every((id) => ids.includes(id))) {
    fail("invalid", "Order every shot exactly once.");
  }
  return ContentPieceSchema.parse({
    ...nextRevision(content, now),
    cut: {
      order,
      mute: patch.mute ?? content.cut.mute,
      captions: patch.captions ?? content.cut.captions,
    },
  });
}

/**
 * Freezes the approved clips, in cut order, into a rendering export record.
 * Every shot needs an approved, active clip; the first one without names its beat.
 * A still clip (a storyboard or image) lasts as long as its beat.
 */
export function beginExport(
  id: string,
  content: ContentPiece,
  script: Script,
  findAsset: (assetId: string) => Asset | undefined,
  now: number,
): ExportRecord {
  if (script.id !== content.scriptId || script.version !== content.scriptVersion) {
    fail("conflict", "The script changed. Review the shots before exporting.");
  }
  const sources = content.cut.order.map((shotId) => {
    const shot = content.shots.find((candidate) => candidate.id === shotId)!;
    const beat = script.beats[shot.beatIndex - 1];
    if (shot.clip.state !== "approved") {
      fail("invalid", `Beat ${shot.beatIndex} has no approved clip. Approve a clip for beat ${shot.beatIndex} before exporting.`);
    }
    const asset = findAsset(shot.clip.assetId);
    if (!asset || asset.state.state !== "active") {
      fail("invalid", `The approved clip for beat ${shot.beatIndex} is missing or archived.`);
    }
    const seconds = asset.video?.durationSeconds ?? beat?.durationSeconds ?? 5;
    let voice: ExportSource["voice"];
    if (shot.voice.state === "approved") {
      const take = findAsset(shot.voice.assetId);
      if (!take || take.state.state !== "active" || take.kind !== "audio" || !take.audio) {
        fail("invalid", `The approved voice-over for beat ${shot.beatIndex} is missing or archived. Approve another take or archive the beat's voice-over.`);
      }
      voice = { assetId: take.id, sha256: take.sha256, durationSeconds: take.audio.durationSeconds };
    }
    return {
      shotId,
      beatIndex: shot.beatIndex,
      assetId: asset.id,
      sha256: asset.sha256,
      durationSeconds: wholeFrames(seconds) / EXPORT_FPS,
      onScreenText: beat?.onScreenText ?? "",
      ...(voice ? { voice } : {}),
    };
  });
  return ExportRecordSchema.parse({
    id,
    contentId: content.id,
    projectId: content.projectId,
    contentRevision: content.revision,
    scriptVersion: content.scriptVersion,
    options: { mute: content.cut.mute, captions: content.cut.captions },
    sources,
    brokenAssetIds: [],
    createdAt: now,
    status: "rendering",
  });
}

/** What a finished render adds to its export record. */
export interface ExportOutput {
  assetId: string;
  sha256: string;
  durationSeconds: number;
  filterSummary: string;
}

export function completeExport(record: ExportRecord, output: ExportOutput, now: number): ExportRecord {
  if (record.status !== "rendering") fail("conflict", "This export already finished.");
  return ExportRecordSchema.parse({ ...record, ...output, status: "completed", completedAt: now });
}

export function failExport(record: ExportRecord, error: string, now: number): ExportRecord {
  if (record.status !== "rendering") fail("conflict", "This export already finished.");
  return ExportRecordSchema.parse({ ...record, status: "failed", error, failedAt: now });
}
