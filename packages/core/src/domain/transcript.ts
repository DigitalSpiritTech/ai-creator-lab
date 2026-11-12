/**
 * Transcripts: a recording's words with start and end times, as a speech to text recipe returns
 * them (Whisper's word timestamps), and the alignment of a script's beats to those times. Pure: the
 * transcript file is read by the server; everything here works on parsed values.
 *
 * Alignment is a weighted longest-common-subsequence between the script's spoken words, in beat
 * order, and the transcript's words, so a few misheard, dropped, or added words never shift a beat.
 * A beat none of whose words were heard is placed in the gap its neighbours leave, and says so.
 * @packageDocumentation
 */
import { z } from "zod";
import type { Beat } from "./script";

/** Longest recording a transcript describes; a take is a 15 to 30 second ad, so this is generous. */
export const MAX_TRANSCRIPT_SECONDS = 600;

const SecondsSchema = z.number().nonnegative().max(MAX_TRANSCRIPT_SECONDS);

export const TranscriptWordSchema = z
  .object({
    /** The word as heard, with its punctuation ("holder."). */
    text: z.string().trim().min(1).max(64),
    start: SecondsSchema,
    end: SecondsSchema,
    /** The model's confidence, when it reports one. */
    probability: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((word) => word.end >= word.start, "A word ends after it starts.");
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const TranscriptSchema = z
  .object({
    /** The spoken language as the model named it ("en", "english"), when it did. */
    language: z.string().trim().min(1).max(32).nullable().default(null),
    /** Length of the recording that was transcribed. */
    durationSeconds: z.number().positive().max(MAX_TRANSCRIPT_SECONDS),
    text: z.string().max(10_000),
    words: z.array(TranscriptWordSchema).max(3000),
  })
  .strict()
  .refine((transcript) => transcript.words.every((word, index) => index === 0 || word.start >= transcript.words[index - 1].start), "Words are in time order.")
  .refine((transcript) => transcript.words.every((word) => word.end <= transcript.durationSeconds + 0.5), "Words end inside the recording.");
export type Transcript = z.infer<typeof TranscriptSchema>;

const rounded = (seconds: number) => Math.round(seconds * 1000) / 1000;

const RawWordSchema = z
  .object({
    word: z.string().optional(),
    text: z.string().optional(),
    start: z.number(),
    end: z.number(),
    probability: z.number().optional(),
  })
  .passthrough();
const RawWhisperSchema = z
  .object({
    text: z.string().optional(),
    language: z.string().nullable().optional(),
    duration: z.number().optional(),
    durationSeconds: z.number().optional(),
    words: z.array(RawWordSchema).optional(),
    segments: z.array(z.object({ words: z.array(RawWordSchema).optional() }).passthrough()).optional(),
  })
  .passthrough();

/**
 * Reads a speech to text result: this app's own transcript, OpenAI's `verbose_json` with
 * `timestamp_granularities: ["word"]` (top-level `words` of `{ word, start, end }`), or the
 * open-weights Whisper shape (`segments[].words` of `{ word, start, end, probability }`).
 * `durationSeconds` is the recording's length when the result does not state it. Throws a readable
 * error for anything else, for a result with no word timestamps, and for one with no words at all
 * (silence, or noise the model could not read): an EDL drafted from it would be all guesses.
 */
export function parseTranscript(raw: unknown, durationSeconds?: number): Transcript {
  const transcript = readTranscript(raw, durationSeconds);
  if (transcript.words.length === 0) throw new Error("The transcription found no words in the recording. Check that it has speech, then transcribe it again.");
  return transcript;
}

function readTranscript(raw: unknown, durationSeconds?: number): Transcript {
  const own = TranscriptSchema.safeParse(raw);
  if (own.success) return own.data;
  const parsed = RawWhisperSchema.safeParse(raw);
  if (!parsed.success) throw new Error("The transcription result is not a Whisper transcript.");
  const result = parsed.data;
  const rawWords = result.words ?? result.segments?.flatMap((segment) => segment.words ?? []) ?? [];
  if (rawWords.length === 0 && (result.text ?? "").trim().length > 0) throw new Error("The transcription result has no word timestamps. Ask for word timestamps.");
  const words = rawWords
    .map((word) => ({
      text: (word.word ?? word.text ?? "").trim(),
      start: rounded(Math.max(0, word.start)),
      end: rounded(Math.max(0, word.start, word.end)),
      ...(word.probability !== undefined ? { probability: Math.min(1, Math.max(0, word.probability)) } : {}),
    }))
    .filter((word) => word.text.length > 0)
    .map((word) => ({ ...word, text: word.text.slice(0, 64) }));
  const length = result.duration ?? result.durationSeconds ?? durationSeconds ?? Math.max(0.1, ...words.map((word) => word.end));
  const text = (result.text ?? words.map((word) => word.text).join(" ")).trim().slice(0, 10_000);
  return TranscriptSchema.parse({ language: result.language?.trim() || null, durationSeconds: rounded(length), text, words });
}

/** A word as alignment compares it: lower case, letters and digits only ("Holder," and "holder" match). */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** The words of a line as alignment compares them; hyphens and dashes split words ("24-hour" is two). */
export function lineWords(line: string): string[] {
  return line
    .split(/[\s\-‐-―/]+/)
    .map(normalizeWord)
    .filter(Boolean);
}

function editDistanceAtMost1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** 2 for the same word, 1 for a near miss on a longer word ("bottles", "bottle"), else 0. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 2;
  if (a.length >= 4 && b.length >= 4 && editDistanceAtMost1(a, b)) return 1;
  return 0;
}

/** Where one beat's line was found on the recording. */
export const BeatSpanSchema = z
  .object({
    beatIndex: z.number().int().positive(),
    start: SecondsSchema,
    end: SecondsSchema,
    /** Script words of the line that were found in the transcript, and how many the line has. */
    matchedWords: z.number().int().nonnegative(),
    totalWords: z.number().int().positive(),
    /** No word of the line was heard: the span is the gap its neighbours leave. */
    estimated: z.boolean(),
  })
  .strict()
  .refine((span) => span.end > span.start, "A beat's span ends after it starts.");
export type BeatSpan = z.infer<typeof BeatSpanSchema>;

export interface Alignment {
  /** Spans of the beats with a spoken line, in beat order. */
  spans: BeatSpan[];
  /** Beats with a line that could not be placed on the recording at all. */
  unplaced: number[];
}

/**
 * Aligns each beat's spoken line to the transcript's word times. Beats without a line are skipped.
 * A beat's span runs from the start of its first matched word to the end of its last one.
 */
export function alignBeats(beats: readonly Pick<Beat, "index" | "spokenLine">[], transcript: Transcript): Alignment {
  const script: { word: string; beat: number }[] = [];
  for (const beat of beats) for (const word of lineWords(beat.spokenLine)) script.push({ word, beat: beat.index });
  const heard = transcript.words.map((word) => normalizeWord(word.text));
  const n = script.length;
  const m = heard.length;
  const width = m + 1;
  const score = new Float64Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const match = heard[j - 1] ? wordSimilarity(script[i - 1].word, heard[j - 1]) : 0;
      const diagonal = match > 0 ? score[(i - 1) * width + j - 1] + match : -1;
      score[i * width + j] = Math.max(score[(i - 1) * width + j], score[i * width + j - 1], diagonal);
    }
  }
  const matched = new Map<number, number[]>();
  for (let i = n, j = m; i > 0 && j > 0; ) {
    const here = score[i * width + j];
    const match = heard[j - 1] ? wordSimilarity(script[i - 1].word, heard[j - 1]) : 0;
    if (match > 0 && here === score[(i - 1) * width + j - 1] + match) {
      const beat = script[i - 1].beat;
      matched.set(beat, [j - 1, ...(matched.get(beat) ?? [])]);
      i--;
      j--;
    } else if (here === score[(i - 1) * width + j]) i--;
    else j--;
  }
  const spoken = beats.filter((beat) => lineWords(beat.spokenLine).length > 0);
  const found = spoken.map((beat) => {
    const indexes = matched.get(beat.index) ?? [];
    const totalWords = lineWords(beat.spokenLine).length;
    if (indexes.length === 0) return { beatIndex: beat.index, totalWords, span: null };
    const first = transcript.words[indexes[0]];
    const last = transcript.words[indexes[indexes.length - 1]];
    return { beatIndex: beat.index, totalWords, span: { start: first.start, end: Math.max(last.end, first.start + 0.05), matchedWords: indexes.length } };
  });
  const spans: BeatSpan[] = [];
  const unplaced: number[] = [];
  for (let position = 0; position < found.length; ) {
    const entry = found[position];
    if (entry.span) {
      spans.push(BeatSpanSchema.parse({ beatIndex: entry.beatIndex, start: rounded(entry.span.start), end: rounded(entry.span.end), matchedWords: entry.span.matchedWords, totalWords: entry.totalWords, estimated: false }));
      position++;
      continue;
    }
    // A run of beats none of whose words were heard shares the gap its neighbours leave, by word count.
    let last = position;
    while (last + 1 < found.length && !found[last + 1].span) last++;
    const run = found.slice(position, last + 1);
    const start = found[position - 1]?.span?.end ?? 0;
    const end = found[last + 1]?.span?.start ?? transcript.durationSeconds;
    const words = run.reduce((sum, other) => sum + other.totalWords, 0);
    let cursor = start;
    for (const other of run) {
      const next = cursor + ((end - start) * other.totalWords) / words;
      if (next - cursor < 0.2) unplaced.push(other.beatIndex);
      else spans.push(BeatSpanSchema.parse({ beatIndex: other.beatIndex, start: rounded(cursor), end: rounded(next), matchedWords: 0, totalWords: other.totalWords, estimated: true }));
      cursor = next;
    }
    position = last + 1;
  }
  return { spans, unplaced };
}
