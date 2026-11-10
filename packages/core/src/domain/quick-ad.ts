/**
 * The Quick Ad (v0.2 F11): the UGC Ad with fewer approvals. A two-line brief becomes a one-beat
 * talking script and an Ad in `quick` mode; then one composed frame, one talking clip, and the
 * export. Three approvals, each a person's click: the frame, the clip, and the export. Each of the
 * two generations still goes through the spend gate like any other.
 *
 * Everything here is pure: the plan's constants, the brief and the beat built from the two lines,
 * and where a Quick Ad stands. The tool that saves them is `start_quick_ad`.
 * @packageDocumentation
 */
import { z } from "zod";
import type { Capability } from "./capability";
import { text, wordCount } from "./common";
import type { ContentPiece } from "./content";
import { type Brief, BriefSchema } from "./project";
import { type BeatInput, BeatInputSchema, WORDS_PER_SECOND, maxWords } from "./script";

export const QUICK_AD = {
  /** One talking beat, so one shot. */
  beats: 1,
  /** One frame candidate per proposal; regenerate for another. */
  frameCount: 1,
  clipCount: 1,
  /**
   * The talking clip's length. Four seconds holds a ten-word line, and keeps the whole Quick Ad
   * under one dollar on Comfy Router even when the frame comes from text (see `tests/quick-ad.test.ts`).
   */
  durationSeconds: 4,
  aspectRatio: "9:16",
  platforms: ["TikTok", "Instagram Reels", "YouTube Shorts"],
  tone: "Warm and direct, like a friend recommending it",
  setting: "a bright kitchen counter by a window",
  /** The three approvals, in order. */
  approvals: ["frame", "clip", "export"],
  /** What a whole Quick Ad may reserve on Comfy Router, priced by the catalog's ceilings. */
  routerBudgetUsd: 1,
} as const;

/** The two lines: what you're selling, and who it's for. */
export const QuickBriefSchema = z
  .object({
    productSummary: text(300).describe("Line 1: what you're selling and the one thing it does, in your words."),
    audience: text(300).describe("Line 2: who it's for, and where it will run."),
  })
  .strict();
export type QuickBrief = z.infer<typeof QuickBriefSchema>;

/** What starts a Quick Ad. Everything but the two lines has a default the person can change. */
export const QuickAdInputSchema = z
  .object({
    brief: QuickBriefSchema,
    spokenLine: text(300).optional().describe("What the creator says on camera; about ten words fit the four-second clip. Defaults to the first line, shortened."),
    onScreenText: z.string().trim().max(80).optional().describe("The caption burned in (two lines of six words at most). Defaults to the start of the first line; an empty string means no caption."),
    setting: text(200).optional().describe("Where the creator stands, for example 'a car interior'."),
    platforms: z.array(text(40)).min(1).max(6).optional(),
    tone: text(200).optional(),
    title: text(120).optional(),
  })
  .strict();
export type QuickAdInput = z.input<typeof QuickAdInputSchema>;

/** The full brief the two lines stand for: the Quick Ad's platforms and tone unless given. */
export function quickBrief(input: Pick<QuickAdInput, "brief" | "platforms" | "tone">): Brief {
  const lines = QuickBriefSchema.parse(input.brief);
  return BriefSchema.parse({
    productSummary: lines.productSummary,
    audience: lines.audience,
    platforms: input.platforms ?? [...QUICK_AD.platforms],
    tone: input.tone ?? QUICK_AD.tone,
  });
}

function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/** The first clause of a line: up to the first period, semicolon, colon, dash, or comma. */
function firstClause(line: string): string {
  return line.split(/(?<=\S)\s*(?:[.;:!?]|\s[-–—]\s|,)\s*/)[0]?.trim() ?? line.trim();
}

/** Words a shortened line should not end on. */
const DANGLING = new Set(["a", "an", "and", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with", "your", "my"]);

/**
 * The line the creator says when none is given: the first line itself when the beat can hold it
 * (`maxWords`), else its first clause at a natural pace (2.5 words a second), else its first words
 * without a dangling "for" or "the", ending in a period.
 */
export function defaultSpokenLine(productSummary: string, seconds: number = QUICK_AD.durationSeconds): string {
  const end = (line: string) => (/[.!?]$/.test(line) ? line : `${line}.`);
  const whole = productSummary.trim();
  if (wordCount(whole) <= maxWords(seconds)) return end(whole);
  const fits = Math.floor(seconds * WORDS_PER_SECOND);
  const clause = firstClause(productSummary);
  if (wordCount(clause) <= fits) return end(clause);
  const kept = words(productSummary).slice(0, fits);
  while (kept.length > 1 && DANGLING.has(kept.at(-1)!.toLowerCase().replace(/[^a-z]/g, ""))) kept.pop();
  return end(kept.join(" ").replace(/[,;:.!?-]+$/, ""));
}

/** The caption when none is given: the first line's first clause, at most six words on one line. */
export function defaultOnScreenText(productSummary: string): string {
  return words(firstClause(productSummary)).slice(0, 6).join(" ").replace(/[,;:-]+$/, "");
}

/** What the project has to compose the frame from. */
export interface QuickAdCast {
  /** A Library character is linked (the still tool adds its visual core, and its sheet or face when locked). */
  character: boolean;
  /** A Library product is linked (its photo and appearance join the frame). */
  product: boolean;
}

/**
 * The Quick Ad's one beat: a talking hook of `QUICK_AD.durationSeconds`, the creator holding the
 * product up to the camera. With a linked character and product, the still tool adds the sheet or
 * face, the product photo, and the appearance line; without them, the visual names them in words.
 */
export function quickAdBeat(input: QuickAdInput, cast: QuickAdCast): BeatInput {
  const data = QuickAdInputSchema.parse(input);
  const who = cast.character ? "The creator" : "A friendly creator in their early 30s";
  const what = cast.product ? "the product" : `the product (${data.brief.productSummary.slice(0, 200)})`;
  return BeatInputSchema.parse({
    type: "talking",
    purpose: "hook",
    spokenLine: data.spokenLine ?? defaultSpokenLine(data.brief.productSummary),
    onScreenText: data.onScreenText ?? defaultOnScreenText(data.brief.productSummary),
    visual: `${who} holds ${what} up beside their face and talks straight to the camera.`,
    setting: data.setting ?? QUICK_AD.setting,
    productVisible: true,
    durationSeconds: QUICK_AD.durationSeconds,
  });
}

/**
 * The two generations a Quick Ad proposes, by capability: the frame is an image edit when the
 * project has a character reference or a product photo to compose from, else text to image; the
 * clip animates the approved frame with the line spoken. One candidate each.
 */
export function quickAdPlan(references: { creator: boolean; productPhoto: boolean }): {
  frame: { capability: Capability; count: number };
  clip: { capability: Capability; count: number; durationSeconds: number };
} {
  return {
    frame: { capability: references.creator || references.productPhoto ? "image_edit" : "text_to_image", count: QUICK_AD.frameCount },
    clip: { capability: "image_to_video", count: QUICK_AD.clipCount, durationSeconds: QUICK_AD.durationSeconds },
  };
}

/** Where a Quick Ad stands: the next approval it waits for, and the ones given. */
export type QuickAdStep = "frame" | "clip" | "export" | "done";

export interface QuickAdProgress {
  next: QuickAdStep;
  /** Approvals given so far, in order (at most three). */
  approved: ("frame" | "clip" | "export")[];
  /** The candidates waiting for a decision at the next step. */
  candidates: string[];
}

/**
 * The next step of a Quick Ad from its content piece and its finished exports: every beat's frame
 * approved, then every beat's clip, then one export. Works for an Ad of any mode; the Quick Ad has
 * one beat.
 */
export function quickAdProgress(content: Pick<ContentPiece, "shots">, completedExports: number): QuickAdProgress {
  const approved: QuickAdProgress["approved"] = [];
  const stills = content.shots.map((shot) => shot.still);
  const clips = content.shots.map((shot) => shot.clip);
  const open = (slots: typeof stills) => slots.flatMap((slot) => (slot.state === "open" ? slot.candidateIds : []));
  if (!stills.every((slot) => slot.state === "approved")) return { next: "frame", approved, candidates: open(stills) };
  approved.push("frame");
  if (!clips.every((slot) => slot.state === "approved")) return { next: "clip", approved, candidates: open(clips) };
  approved.push("clip");
  if (completedExports === 0) return { next: "export", approved, candidates: [] };
  approved.push("export");
  return { next: "done", approved, candidates: [] };
}
