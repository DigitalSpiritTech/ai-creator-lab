/**
 * Content pieces (the Ad), their shots, the cut, and export records.
 * A shot is one beat's production: still candidates and approval, then clip candidates and approval.
 * An Ad assembled take-then-cutaways also has a take (one continuous talking clip of the whole
 * script, with candidates and an approval like a shot's slot) and its edit decision list.
 * @packageDocumentation
 */
import { z } from "zod";
import type { Asset } from "./asset";
import {
  IdSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampSchema,
  nextRevision,
  text,
} from "./common";
import { type Edl, EdlCueSchema, EdlSchema, syncEdlToScript } from "./edl";
import { fail } from "./failure";
import type { Script, ScriptChange } from "./script";

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

/**
 * How an Ad is made: `full` is the whole UGC Creator flow (character, face lock, body, sheet,
 * product, script, shots, voice-overs); `quick` is the Quick Ad (F11): a two-line brief, one
 * composed frame, one talking clip, and the export. Both use the same shots, cut, and assembly.
 */
export const AdModeSchema = z.enum(["full", "quick"]);
export type AdMode = z.infer<typeof AdModeSchema>;

export const ContentPieceSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    type: z.literal("ad"),
    /** Saved before modes existed means `full`. */
    mode: AdModeSchema.default("full"),
    title: text(120),
    scriptId: IdSchema,
    scriptVersion: z.number().int().positive(),
    shots: z.array(ShotSchema).max(8),
    cut: CutSchema,
    /** The full talking take for a take-then-cutaways export: every line of the script in one clip. */
    take: SlotSchema.default({ state: "empty" }),
    /** The take's edit decision list (a document, kind `edl`); null until one is drafted. */
    edl: EdlSchema.nullable().default(null),
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
    /** A talking beat: the clip's own sound is speech and is leveled with the voice-overs. */
    speech: z.boolean().default(false),
    /** The approved voice-over take mixed over this segment, when the beat has one. */
    voice: z.object({ assetId: IdSchema, sha256: Sha256Schema, durationSeconds: z.number().positive() }).strict().optional(),
    /** Take-then-cutaways: where on the take this clip replaces the picture, in seconds. */
    window: z.object({ start: z.number().nonnegative(), end: z.number().positive() }).strict().optional(),
  })
  .strict();
export type ExportSource = z.infer<typeof ExportSourceSchema>;

/**
 * How an export is built: `component` joins one approved clip per beat in cut order;
 * `take_cutaways` keeps one continuous talking take (its sound untouched) and replaces the picture
 * in the EDL's b-roll windows, with captions at the EDL's times.
 */
export const AssemblyStrategySchema = z.enum(["component", "take_cutaways"]);
export type AssemblyStrategy = z.infer<typeof AssemblyStrategySchema>;

/** The approved take a take-then-cutaways export was cut from, pinned by hash. */
export const ExportTakeSchema = z
  .object({ assetId: IdSchema, sha256: Sha256Schema, durationSeconds: z.number().positive().max(120) })
  .strict();
export type ExportTake = z.infer<typeof ExportTakeSchema>;

const exportBase = {
  id: IdSchema,
  contentId: IdSchema,
  projectId: IdSchema,
  contentRevision: RevisionSchema,
  scriptVersion: z.number().int().positive(),
  options: z.object({ mute: z.boolean(), captions: z.boolean() }).strict(),
  /** Component: one clip per beat. Take-then-cutaways: the windows' clips (possibly none). */
  sources: z.array(ExportSourceSchema).max(8),
  strategy: AssemblyStrategySchema.default("component"),
  /** Take-then-cutaways: the take, the EDL version it was cut from, and its captions as frozen. */
  take: ExportTakeSchema.optional(),
  edlVersion: z.number().int().positive().optional(),
  captionCues: z.array(EdlCueSchema).max(64).optional(),
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
]).refine(
  (record) =>
    record.strategy === "take_cutaways"
      ? record.take !== undefined && record.edlVersion !== undefined
      : record.sources.length > 0 && record.take === undefined,
  "A component export has one source per beat; a take-then-cutaways export names its take and EDL version.",
);
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
  mode: AdMode = "full",
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
    mode,
    title,
    scriptId: script.id,
    scriptVersion: script.version,
    shots,
    cut: { order: shots.map((shot) => shot.id), mute: false, captions: true },
    take: EMPTY_SLOT,
    edl: null,
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
 * empty shots. The cut keeps the user's order for surviving shots and appends new ones. The take
 * speaks every line, so a changed line, or an added or removed beat, withdraws its approval; the
 * EDL drops windows of beats that are gone or became talking beats.
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
  const takeStale = change.voiceInvalidated.length > 0 || change.added.length > 0 || change.removed.length > 0;
  return ContentPieceSchema.parse({
    ...nextRevision(content, now),
    scriptVersion: script.version,
    shots,
    cut: { ...content.cut, order: [...kept, ...appended] },
    take: takeStale ? withdrawApproval(content.take) : content.take,
    edl: content.edl ? syncEdlToScript(content.edl, script.beats) : null,
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
    // A talking beat's take is the clip's own speech (lip-synced or not), never a second layer.
    if (shot.voice.state === "approved" && beat?.type !== "talking") {
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
      speech: beat?.type === "talking",
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

/** Adds generated takes to the Ad's take slot. An approved take stays approved. */
export function addTakeCandidates(content: ContentPiece, assetIds: string[], now: number): ContentPiece {
  const current = content.take;
  const before = current.state === "empty" ? [] : current.candidateIds;
  const added = assetIds.filter((id) => !before.includes(id));
  if (added.length === 0) return content;
  const candidateIds = [...before, ...added];
  const take: Slot =
    current.state === "approved" ? { ...current, candidateIds } : { state: "open", candidateIds, selectedId: current.state === "open" ? current.selectedId : null };
  return ContentPieceSchema.parse({ ...nextRevision(content, now), take });
}

/**
 * Approves one take and returns the other candidates so the caller can archive them. The EDL is
 * kept: it names the take it was drafted for, and an export from another take is refused until it
 * is drafted again.
 */
export function approveTake(content: ContentPiece, assetId: string, now: number): { content: ContentPiece; siblingIds: string[] } {
  const current = content.take;
  if (current.state === "empty" || !current.candidateIds.includes(assetId)) fail("invalid", "Choose one of this Ad's takes.");
  const siblingIds = current.candidateIds.filter((id) => id !== assetId);
  if (current.state === "approved" && current.assetId === assetId) return { content, siblingIds };
  return {
    content: ContentPieceSchema.parse({ ...nextRevision(content, now), take: { state: "approved", candidateIds: current.candidateIds, assetId, approvedAt: now } }),
    siblingIds,
  };
}

/** Saves the Ad's EDL (already checked by the EDL functions). */
export function setEdl(content: ContentPiece, edl: Edl | null, now: number): ContentPiece {
  return ContentPieceSchema.parse({ ...nextRevision(content, now), edl });
}

/**
 * Freezes a take-then-cutaways export: the approved take, and for each EDL window the beat's
 * approved, active clip, pinned by hash, with the captions as they stand. Nothing about the shots'
 * cut order matters here; the take's timeline is the order. Refuses, naming what to fix, when the
 * take is not approved, the EDL is missing or was drafted for another take, or a window's beat has
 * no approved clip. `edlVersion` is the EDL's newest document version (0 when none was saved).
 */
export function beginCutawayExport(
  id: string,
  content: ContentPiece,
  script: Script,
  edlVersion: number,
  findAsset: (assetId: string) => Asset | undefined,
  now: number,
): ExportRecord {
  if (script.id !== content.scriptId || script.version !== content.scriptVersion) {
    fail("conflict", "The script changed. Review the shots before exporting.");
  }
  if (content.take.state !== "approved") fail("invalid", "Approve a talking take for this Ad before a take-then-cutaways export (generate_take).");
  const edl = content.edl ?? fail("invalid", "Draft the edit decision list from the take's transcript first (save_edl).");
  if (edlVersion < 1) fail("invalid", "Save the edit decision list first (save_edl), so the export can name its version.");
  if (edl.take.assetId !== content.take.assetId) fail("conflict", "The edit decision list was drafted for another take. Transcribe the approved take and draft it again.");
  const take = findAsset(content.take.assetId);
  if (!take || take.state.state !== "active" || take.kind !== "video" || !take.video) fail("invalid", "The approved take is missing, archived, or not a video.");
  if (take.sha256 !== edl.take.sha256) fail("conflict", "The take changed since the edit decision list was drafted. Draft it again.");
  if (!take.video.hasAudio) fail("invalid", "The approved take has no sound; a take-then-cutaways export keeps the take's audio.");
  const sources = edl.windows.map((window) => {
    const shot = content.shots.find((candidate) => candidate.beatIndex === window.beatIndex);
    if (!shot) fail("invalid", `Beat ${window.beatIndex} has no shot in this Ad.`);
    if (shot.clip.state !== "approved") {
      fail("invalid", `Beat ${window.beatIndex} fills a window but has no approved clip. Approve a clip for beat ${window.beatIndex}, or remove its window.`);
    }
    const clip = findAsset(shot.clip.assetId);
    if (!clip || clip.state.state !== "active") fail("invalid", `The approved clip for beat ${window.beatIndex} is missing or archived.`);
    const frames = Math.max(1, Math.round(window.end * EXPORT_FPS) - Math.round(window.start * EXPORT_FPS));
    return {
      shotId: shot.id,
      beatIndex: shot.beatIndex,
      assetId: clip.id,
      sha256: clip.sha256,
      durationSeconds: frames / EXPORT_FPS,
      onScreenText: "",
      speech: false,
      window: { start: window.start, end: window.end },
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
    strategy: "take_cutaways",
    take: { assetId: take.id, sha256: take.sha256, durationSeconds: take.video.durationSeconds },
    edlVersion,
    captionCues: edl.captions,
    brokenAssetIds: [],
    createdAt: now,
    status: "rendering",
  });
}
