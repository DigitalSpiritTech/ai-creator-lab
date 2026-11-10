/**
 * The edit decision list (EDL) of a take-then-cutaways Ad: one continuous talking take, the b-roll
 * windows cut into it, and the captions, all as times on the take. It is a document in the
 * artifact panel (kind `edl`, subject the Ad), drafted from the take's transcript and edited in
 * place; exporting it again re-renders from the same approved media, so nothing is regenerated.
 *
 * In a window the picture is the beat's approved clip, from its first frame; the sound is always
 * the take's, untouched. Pure: no files, no processes.
 * @packageDocumentation
 */
import { z } from "zod";
import { MAX_TAKE_SECONDS } from "../catalog/length";
import { IdSchema, Sha256Schema } from "./common";
import { fail } from "./failure";
import type { Beat, Script, ScriptChange } from "./script";
import { type BeatSpan, BeatSpanSchema, type Transcript, alignBeats } from "./transcript";

/**
 * The longest talking recording a take-then-cutaways Ad asks for (its beats added up, capped here):
 * the longest recording a chain plans, one constant for both (`@creator-lab/core/catalog/length`).
 */
export { MAX_TAKE_SECONDS };
/**
 * How far past MAX_TAKE_SECONDS a delivered file may run: models round a length up to their own
 * frame rule (LTX's 8n+1 makes 60.04 s of a 60 s request). Schemas accept the file; requests never ask for it.
 */
export const TAKE_ROUNDING_SECONDS = 1;
const LONGEST_FILE_SECONDS = MAX_TAKE_SECONDS + TAKE_ROUNDING_SECONDS;
/** A window shorter than this is a flash frame, not a cutaway. */
export const EDL_MIN_WINDOW_SECONDS = 0.5;
const EPSILON = 1e-6;

const SecondsSchema = z.number().nonnegative().max(LONGEST_FILE_SECONDS);
const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** The approved take the EDL cuts, pinned by hash. */
export const EdlTakeSchema = z
  .object({ assetId: IdSchema, sha256: Sha256Schema, durationSeconds: z.number().positive().max(LONGEST_FILE_SECONDS) })
  .strict();
export type EdlTake = z.infer<typeof EdlTakeSchema>;

/** A b-roll window: from `start` to `end` on the take, the picture is beat `beatIndex`'s approved clip. */
export const EdlWindowSchema = z
  .object({ beatIndex: z.number().int().positive(), start: SecondsSchema, end: SecondsSchema })
  .strict()
  .refine((window) => window.end - window.start >= EDL_MIN_WINDOW_SECONDS - EPSILON, `A window lasts at least ${EDL_MIN_WINDOW_SECONDS} s.`);
export type EdlWindow = z.infer<typeof EdlWindowSchema>;

/** A caption burned in from `start` to `end` on the take; at most two lines. */
export const EdlCueSchema = z
  .object({ start: SecondsSchema, end: SecondsSchema, text: z.string().trim().min(1).max(80) })
  .strict()
  .refine((cue) => cue.end > cue.start, "A caption ends after it starts.")
  .refine((cue) => cue.text.split("\n").filter((line) => line.trim()).length <= 2, "A caption is at most two lines.");
export type EdlCue = z.infer<typeof EdlCueSchema>;

function inOrder(entries: readonly { start: number; end: number }[]): boolean {
  return entries.every((entry, index) => index === 0 || entry.start >= entries[index - 1].end - EPSILON);
}

export const EdlSchema = z
  .object({
    take: EdlTakeSchema,
    /** The transcript the draft was aligned from; null once it was deleted, or for a hand-made list. */
    transcriptAssetId: IdSchema.nullable(),
    /** The script version the draft was made from. */
    scriptVersion: z.number().int().positive(),
    /** Where each beat's line was heard on the take (the alignment), for reference while editing. */
    beats: z.array(BeatSpanSchema).max(8),
    windows: z.array(EdlWindowSchema).max(8),
    captions: z.array(EdlCueSchema).max(64),
  })
  .strict()
  .superRefine((edl, context) => {
    const length = edl.take.durationSeconds + EPSILON;
    if (edl.windows.some((window) => window.end > length) || edl.captions.some((cue) => cue.end > length)) {
      context.addIssue({ code: "custom", message: `Every window and caption ends inside the recording (${edl.take.durationSeconds} s).` });
    }
    if (!inOrder(edl.windows)) context.addIssue({ code: "custom", path: ["windows"], message: "Windows are in time order and do not overlap." });
    if (new Set(edl.windows.map((window) => window.beatIndex)).size !== edl.windows.length) {
      context.addIssue({ code: "custom", path: ["windows"], message: "Each beat fills at most one window." });
    }
    if (!inOrder(edl.captions)) context.addIssue({ code: "custom", path: ["captions"], message: "Captions are in time order and do not overlap." });
  });
export type Edl = z.infer<typeof EdlSchema>;
export type EdlInput = z.input<typeof EdlSchema>;

/** What a person or the assistant may change: the windows and the captions. */
export const EdlPatchSchema = z
  .object({
    windows: z.array(EdlWindowSchema).max(8).optional(),
    captions: z.array(EdlCueSchema).max(64).optional(),
  })
  .strict();
export type EdlPatch = z.infer<typeof EdlPatchSchema>;

const byStart = <T extends { start: number }>(entries: readonly T[]) => [...entries].sort((a, b) => a.start - b.start);

function checkBeats(edl: Edl, beats: readonly Pick<Beat, "index" | "type">[]): void {
  for (const window of edl.windows) {
    const beat = beats[window.beatIndex - 1];
    if (!beat) fail("invalid", `Beat ${window.beatIndex} is not in the script.`);
    if (beat.type === "talking") fail("invalid", `Beat ${window.beatIndex} is a talking beat; its picture is the talking recording itself. Windows show b-roll and text card beats.`);
  }
}

/**
 * Parses an EDL with every time rounded to the millisecond and windows and captions sorted. A list
 * that breaks a rule (overlap, outside the take, too short) is refused with the rule, as "invalid".
 */
export function normalizeEdl(input: EdlInput): Edl {
  const result = EdlSchema.safeParse({
    ...input,
    windows: byStart(input.windows.map((window) => ({ ...window, start: ms(window.start), end: ms(window.end) }))),
    captions: byStart(input.captions.map((cue) => ({ ...cue, start: ms(cue.start), end: ms(cue.end) }))),
  });
  if (!result.success) fail("invalid", `The edit decision list was not saved: ${result.error.issues[0]?.message ?? "it is not valid"}`);
  return result.data;
}

export interface DraftEdlInput {
  script: Script;
  take: EdlTake;
  transcript: Transcript;
  transcriptAssetId: string;
}

/**
 * Drafts the EDL from the take's transcript. Each b-roll or text card beat whose line was heard
 * gets a window from its first word to the next line's first word (or the end of the take), so
 * the cut back to the face lands as the next talking line starts. Each beat's on-screen text is a
 * caption over the same stretch. `unplaced` lists the non-talking beats that got no window: a beat
 * with no line has no time on the take, and a line the take never says cannot be found.
 */
export function draftEdl({ script, take, transcript, transcriptAssetId }: DraftEdlInput): { edl: Edl; unplaced: number[] } {
  const alignment = alignBeats(script.beats, transcript);
  const spans = alignment.spans.filter((span) => span.start < take.durationSeconds);
  const until = (position: number) => Math.min(take.durationSeconds, spans[position + 1]?.start ?? take.durationSeconds);
  const windows: EdlWindow[] = [];
  const captions: EdlCue[] = [];
  spans.forEach((span, position) => {
    const beat = script.beats[span.beatIndex - 1];
    const end = until(position);
    if (beat.type !== "talking" && end - span.start >= EDL_MIN_WINDOW_SECONDS) windows.push({ beatIndex: beat.index, start: span.start, end });
    const text = beat.onScreenText.trim();
    if (text && end > span.start) captions.push({ start: span.start, end, text });
  });
  const placed = new Set(windows.map((window) => window.beatIndex));
  const unplaced = script.beats.filter((beat) => beat.type !== "talking" && !placed.has(beat.index)).map((beat) => beat.index);
  const edl = normalizeEdl({
    take,
    transcriptAssetId,
    scriptVersion: script.version,
    beats: spans.map((span: BeatSpan) => ({ ...span, end: Math.min(span.end, take.durationSeconds) })).filter((span) => span.end > span.start),
    windows,
    captions,
  });
  return { edl, unplaced };
}

/** Saves an edit: new windows or captions replace the old ones, checked against the take and the script's beats. */
export function reviseEdl(edl: Edl, patch: EdlPatch, script: Pick<Script, "beats">): Edl {
  const next = normalizeEdl({ ...edl, ...(patch.windows ? { windows: patch.windows } : {}), ...(patch.captions ? { captions: patch.captions } : {}) });
  checkBeats(next, script.beats);
  return next;
}

/** Moves one window by `seconds` (later when positive), keeping its length; refused when it would leave the take or overlap another. */
export function shiftWindow(edl: Edl, beatIndex: number, seconds: number): Edl {
  const window = edl.windows.find((entry) => entry.beatIndex === beatIndex) ?? fail("not_found", `No window shows beat ${beatIndex}.`);
  const moved = { ...window, start: ms(window.start + seconds), end: ms(window.end + seconds) };
  if (moved.start < 0 || moved.end > edl.take.durationSeconds + EPSILON) fail("invalid", `Moved by ${seconds} s, the window for beat ${beatIndex} would leave the recording.`);
  const result = EdlSchema.safeParse({ ...edl, windows: byStart(edl.windows.map((entry) => (entry.beatIndex === beatIndex ? moved : entry))) });
  if (!result.success) fail("invalid", `Moved by ${seconds} s, the window for beat ${beatIndex} would overlap another window.`);
  return result.data;
}

/**
 * Keeps an EDL in step with a script revision. Windows of beats that were removed, or that became
 * talking beats, are dropped; times are left alone, the take decides them. With the previous
 * version (`before`), a beat whose on-screen text changed carries the change into the caption
 * that still holds its old text (a caption the person rewrote keeps their words), and a caption
 * whose beat lost its text is dropped. When no line changed and no beat was added or removed, the
 * take still says the whole script, so the list moves to the new script version; otherwise it
 * stays on the old one and the export asks for a new draft.
 */
export function syncEdlToScript(
  edl: Edl,
  after: Pick<Script, "version" | "beats">,
  before?: Pick<Script, "beats">,
  change?: ScriptChange,
): Edl {
  const beats = after.beats;
  const windows = edl.windows.filter((window) => beats[window.beatIndex - 1] && beats[window.beatIndex - 1].type !== "talking");
  let captions = edl.captions;
  if (before) {
    for (const beat of beats) {
      const old = before.beats[beat.index - 1]?.onScreenText.trim() ?? "";
      const now = beat.onScreenText.trim();
      if (!old || old === now) continue;
      captions = now ? captions.map((cue) => (cue.text.trim() === old ? { ...cue, text: now } : cue)) : captions.filter((cue) => cue.text.trim() !== old);
    }
  }
  const reconciled = !!before && !!change && change.voiceInvalidated.length === 0 && change.added.length === 0 && change.removed.length === 0;
  const scriptVersion = reconciled ? Math.max(edl.scriptVersion, after.version) : edl.scriptVersion;
  if (windows.length === edl.windows.length && captions === edl.captions && scriptVersion === edl.scriptVersion) return edl;
  return EdlSchema.parse({ ...edl, windows, captions, scriptVersion });
}

/** Beats whose span was placed by estimate (none of their words was heard). */
export function estimatedBeats(edl: Edl): number[] {
  return edl.beats.filter((span) => span.estimated).map((span) => span.beatIndex);
}

/** One line for a version list: the windows as beat@start-end. */
export function edlSummary(edl: Edl): string {
  const windows = edl.windows.map((window) => `beat ${window.beatIndex} ${window.start.toFixed(1)}-${window.end.toFixed(1)} s`);
  return `${edl.take.durationSeconds.toFixed(1)} s recording · ${windows.length ? windows.join(", ") : "no windows"} · ${edl.captions.length} captions`;
}
