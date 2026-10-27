/**
 * Versioned UGC ad scripts made of beats, following the ugc-script skill.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, TimestampSchema, optionalText, text, wordCount } from "@/lib/domain/common";

export const BeatTypeSchema = z.enum(["talking", "broll", "textcard"]);
export type BeatType = z.infer<typeof BeatTypeSchema>;

export const BeatPurposeSchema = z.enum(["hook", "problem", "reveal", "proof", "cta"]);
export type BeatPurpose = z.infer<typeof BeatPurposeSchema>;

const beatFields = {
  type: BeatTypeSchema,
  purpose: BeatPurposeSchema,
  spokenLine: optionalText(160),
  onScreenText: optionalText(80),
  visual: text(400),
  setting: optionalText(200),
  productVisible: z.boolean().default(false),
  /** Seconds, 1 to 15; each video recipe states what it accepts (LTX any length, Kling whole seconds 3 to 15, Wan 5). */
  durationSeconds: z.number().positive().max(15).default(5),
  notes: optionalText(500),
};

type BeatShape = { type: BeatType; spokenLine: string; onScreenText: string };

function checkBeat(beat: BeatShape, context: z.RefinementCtx): void {
  if (beat.type === "talking" && beat.spokenLine.length === 0) {
    context.addIssue({ code: "custom", message: "A talking beat needs a spoken line.", path: ["spokenLine"] });
  }
  if (wordCount(beat.spokenLine) > 15) {
    context.addIssue({ code: "custom", message: "Keep the spoken line to 15 words or fewer.", path: ["spokenLine"] });
  }
  const lines = beat.onScreenText.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > 2 || lines.some((line) => wordCount(line) > 6)) {
    context.addIssue({
      code: "custom",
      message: "On-screen text is at most two lines of six words.",
      path: ["onScreenText"],
    });
  }
}

/** A beat as written by the assistant or the user; its index comes from its position. */
export const BeatInputSchema = z.object(beatFields).strict().superRefine(checkBeat);
export type BeatInput = z.input<typeof BeatInputSchema>;

export const BeatSchema = z
  .object({ index: z.number().int().positive(), ...beatFields })
  .strict()
  .superRefine(checkBeat);
export type Beat = z.infer<typeof BeatSchema>;

export const ScriptSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    title: text(120),
    version: z.number().int().positive(),
    beats: z.array(BeatSchema).min(1).max(8),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (script) => script.beats.every((beat, position) => beat.index === position + 1),
    "Beats are numbered from 1 in order.",
  );
export type Script = z.infer<typeof ScriptSchema>;

/** Which beats lose approvals after a revision. Beat numbers are 1-based. */
export const ScriptChangeSchema = z
  .object({
    stillInvalidated: z.array(z.number().int().positive()),
    clipInvalidated: z.array(z.number().int().positive()),
    added: z.array(z.number().int().positive()),
    removed: z.array(z.number().int().positive()),
  })
  .strict();
export type ScriptChange = z.infer<typeof ScriptChangeSchema>;

function numberBeats(beats: BeatInput[]): Beat[] {
  return beats.map((beat, position) => BeatSchema.parse({ ...beat, index: position + 1 }));
}

export function createScript(id: string, projectId: string, title: string, beats: BeatInput[], now: number): Script {
  return ScriptSchema.parse({
    id,
    projectId,
    title,
    version: 1,
    beats: numberBeats(beats),
    createdAt: now,
    updatedAt: now,
  });
}

/** What a still is composed from. A change here invalidates the beat's still and clip. */
export function visualSignature(beat: Beat): string {
  return JSON.stringify([beat.type, beat.visual, beat.setting, beat.productVisible]);
}

/** What a clip adds on top of its still. A change here invalidates only the clip. */
export function clipSignature(beat: Beat): string {
  return JSON.stringify([beat.spokenLine, beat.durationSeconds]);
}

/**
 * Compares two versions of a script: a beat whose visual changed loses its still and clip; a beat
 * whose spoken line or length changed loses only its clip; text-only edits (on-screen text,
 * purpose, notes) keep both.
 */
export function diffScripts(before: Script, after: Script): ScriptChange {
  const change: ScriptChange = { stillInvalidated: [], clipInvalidated: [], added: [], removed: [] };
  for (const beat of after.beats) {
    const previous = before.beats[beat.index - 1];
    if (!previous) {
      change.added.push(beat.index);
    } else if (visualSignature(previous) !== visualSignature(beat)) {
      change.stillInvalidated.push(beat.index);
      change.clipInvalidated.push(beat.index);
    } else if (clipSignature(previous) !== clipSignature(beat)) {
      change.clipInvalidated.push(beat.index);
    }
  }
  for (const beat of before.beats) {
    if (beat.index > after.beats.length) change.removed.push(beat.index);
  }
  return change;
}

/** Saves a new script version and reports which beats lose approvals (see `diffScripts`). */
export function reviseScript(
  script: Script,
  title: string,
  beats: BeatInput[],
  now: number,
): { script: Script; change: ScriptChange } {
  const next = ScriptSchema.parse({
    ...script,
    title,
    version: script.version + 1,
    beats: numberBeats(beats),
    updatedAt: now,
  });
  return { script: next, change: diffScripts(script, next) };
}
