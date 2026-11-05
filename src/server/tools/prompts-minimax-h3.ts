/**
 * MiniMax H3 prompts rendered from a structured shot spec, following the minimax-h3-prompting
 * skill (distilled from MiniMax's official base-mode and full-reference prompt guides and the
 * Comfy H3 pages). Never reuse an LTX prompt for H3: the two models read different structures.
 *
 * Three renderers share one spec:
 * - {@link renderH3Prompt}: full-reference mode for the multi-frame reference workflow (subject
 *   definitions, `<Picture N>` roles, timestamped cuts, retention analysis).
 * - {@link renderH3SingleShot}: base image-to-video from a first frame (and first-and-last when the
 *   spec carries a last frame), for `minimax-h3-i2v` and `minimax-h3-flf2v`.
 * - {@link renderH3Chain}: image-to-video segments chained on each segment's last frame, each
 *   ending on a pose that sets up the next segment.
 *
 * Every renderer validates with Zod and returns a discriminated result instead of throwing. Content
 * rules: the renderer adds no identity details beyond the subject's description and wardrobe,
 * describes the product only by the card's appearance line, never names it, adds no on-screen text,
 * and states what should appear rather than listing negatives (H3 runs at cfg 1 with no negative
 * branch, so a ban list adds the banned concept).
 *
 * The base modes anchor rather than describe: when <Picture 1> shows a subject, the subject's
 * description, wardrobe, the product's look, and the setting and light are carried by the image and
 * referred to with a preservation clause, as in MiniMax's own I2VA example. Restating them gave the
 * model a second instruction to render the same traits, and H3 exaggerated them (2026-11-04 spike).
 * @packageDocumentation
 */
import { z } from "zod";
import { wordCount } from "@/lib/domain/common";
import { WORDS_PER_SECOND } from "@/lib/domain/script";
import { productAppearance, withoutProductName } from "@/server/tools/prompts";

/** H3 renders at 24 frames per second. */
export const H3_FPS = 24;

/** The R2V node accepts up to nine reference images, `<Picture 1>` to `<Picture 9>`. */
export const H3_MAX_PICTURES = 9;

/** The longest spec this module accepts; longer native runs are still to be measured. */
export const H3_MAX_SECONDS = 15;

/**
 * The longest prompt a renderer may return. Full-reference prompts are long by design (the guide
 * aims for 350 to 500 words of shot description), so this is well above the image recipes' limit.
 */
export const H3_PROMPT_LIMIT = 6000;

/** A still image anchored with Add Guide occupies one frame. */
export const GUIDE_FRAMES = 1;

/** The default look: candid vertical phone video, as an adjective phrase ("uses a ... style"). */
export const H3_DEFAULT_STYLE = "live-action, candid vertical phone-video UGC";

/**
 * The frame count for a duration under the H3 length rule: the smallest 17n+5 frames at 24 fps
 * that covers the requested seconds, so the planned shots always fit (5 s gives 124 frames).
 */
export function framesForSeconds(seconds: number): number {
  const wanted = Math.round(Math.max(0, seconds) * H3_FPS);
  const n = Math.max(0, Math.ceil((wanted - 5) / 17));
  return 17 * n + 5;
}

/** The Add Guide `frame_idx` for a moment, as the multi-frame template computes it: round(seconds * 24). */
export function frameIndexAt(seconds: number): number {
  return Math.round(seconds * H3_FPS);
}

/** The index of the last generated frame, which a chain extracts as the next segment's first frame. */
export function lastFrameIndex(seconds: number): number {
  return framesForSeconds(seconds) - 1;
}

/** A cut time in the guide's single-timestamp form, `MM:SS.mmm` (3.5 s reads `00:03.500`). */
export function h3Timestamp(seconds: number): string {
  const millis = Math.round(seconds * 1000);
  const minutes = Math.floor(millis / 60000);
  const rest = (millis - minutes * 60000) / 1000;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

function line(max: number) {
  return z.string().trim().min(1).max(max);
}

const SubjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use a short lowercase subject id such as avery.");

/** Camera moves from the guide's vocabulary; written as one natural sentence in the shot. */
export const H3CameraMoveSchema = z.enum([
  "static",
  "push_in",
  "pull_out",
  "zoom_in",
  "zoom_out",
  "pan_left",
  "pan_right",
  "truck_left",
  "truck_right",
  "tilt_up",
  "tilt_down",
  "pedestal_up",
  "pedestal_down",
  "arc",
  "tracking",
  "shake_slightly",
]);
export type H3CameraMove = z.infer<typeof H3CameraMoveSchema>;

export const H3CameraSchema = z
  .object({
    move: H3CameraMoveSchema,
    /** Omit for the default medium amplitude. */
    amplitude: z.enum(["small", "large"]).optional(),
    /** Omit for the default normal speed. */
    speed: z.enum(["slow", "fast"]).optional(),
    /** Continues the camera sentence, for example "toward the bottle in her hand". */
    detail: line(200).optional(),
  })
  .strict();
export type H3Camera = z.infer<typeof H3CameraSchema>;

export const H3SubjectSchema = z
  .object({
    id: SubjectIdSchema,
    /** The short name actions use ("Avery"); full-reference prompts swap it for the subject's label. */
    name: line(60),
    /**
     * The bible's visual core, verbatim. The renderer adds no identity detail of its own. Full-reference
     * mode defines the subject with it; the base modes leave it out when <Picture 1> shows the subject.
     */
    description: line(600),
    /** The project's wardrobe words: repeated in every full-reference shot, and in the base modes only for a subject <Picture 1> does not show. */
    wardrobe: line(200),
    /** How the voice sounds, from the bible (timbre, pace), stated at the first line the subject speaks. */
    voice: line(200).optional(),
  })
  .strict();
export type H3Subject = z.infer<typeof H3SubjectSchema>;

/**
 * What a reference image does. `identity` defines a subject only; `first_frame`, `keyframe`, and
 * `last_frame` pin a composition on the timeline (and may also define the subject they show).
 */
export const H3PictureRoleSchema = z.enum(["identity", "first_frame", "keyframe", "last_frame"]);
export type H3PictureRole = z.infer<typeof H3PictureRoleSchema>;

export const H3PictureSchema = z
  .object({
    /** The `ref_images` slot, so `<Picture N>`; pictures are listed in slot order from 1. */
    index: z.number().int().min(1).max(H3_MAX_PICTURES),
    role: H3PictureRoleSchema,
    /** The subject this image shows; required for identity. */
    subject: SubjectIdSchema.optional(),
    /** A character reference sheet (portrait, full-body front, full-body back panels). */
    sheet: z.boolean().default(false),
    /** The shot (1-based) a frame anchor belongs to. */
    shot: z.number().int().min(1).optional(),
    /** When a keyframe is pinned; first frames sit at their shot's start, last frames at the end. */
    atSeconds: z.number().min(0).optional(),
    /** What the image shows, for frame anchors. */
    shows: line(300).optional(),
  })
  .strict();
export type H3Picture = z.infer<typeof H3PictureSchema>;

export const H3ShotSchema = z
  .object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    /** Shot size, for example "medium close-up" or "close-up". */
    framing: line(80).default("medium close-up"),
    setting: line(300),
    lighting: line(200),
    /** Subject ids visible in this shot. */
    subjects: z.array(SubjectIdSchema).max(4).default([]),
    /** The one action of the shot, written naturally ("Avery lifts the bottle toward the camera."). */
    action: line(400),
    camera: H3CameraSchema,
    /** Where the product is, for example "held in Avery's right hand at chest height"; the look comes from the product card. */
    product: line(200).optional(),
    /** A sound synchronized with this shot ("The cap clicks shut."). */
    sound: line(200).optional(),
  })
  .strict();
export type H3Shot = z.infer<typeof H3ShotSchema>;

export const H3DialogueLineSchema = z
  .object({
    speaker: SubjectIdSchema,
    /** The spoken words, verbatim from the script. */
    text: line(300),
    /** The shot (1-based) the line is spoken in. */
    shot: z.number().int().min(1),
    /** Delivery as a phrase after "says", for example "matter-of-factly" or "with a small laugh". */
    tone: line(120).optional(),
    /** A voice-over: the speaker's lips stay closed if they are in frame. */
    offscreen: z.boolean().default(false),
  })
  .strict();
export type H3DialogueLine = z.infer<typeof H3DialogueLineSchema>;

export const H3ProductSchema = z
  .object({
    /** The card's name, removed from every field; prompts never print it. */
    name: line(120),
    /** The card's appearance line, the only words used to describe the product. */
    appearance: line(300).optional(),
  })
  .strict();

const specFields = {
  /** An adjective phrase for the look, read as "uses a ... style". */
  style: line(200).default(H3_DEFAULT_STYLE),
  /** The language tag inside every `<d>` block. */
  language: line(30).default("English"),
  durationSeconds: z.number().positive().max(H3_MAX_SECONDS),
  subjects: z.array(H3SubjectSchema).max(4).default([]),
  pictures: z.array(H3PictureSchema).max(H3_MAX_PICTURES).default([]),
  shots: z.array(H3ShotSchema).min(1).max(8),
  dialogue: z.array(H3DialogueLineSchema).max(12).default([]),
  product: H3ProductSchema.optional(),
  /** Ambience, action sounds, and non-verbal sounds across the video, one to four sentences. */
  soundscape: line(600),
  /** Score only the audience hears, one to three sentences, or N/A. */
  music: line(300).default("N/A"),
};

type SpecShape = z.infer<z.ZodObject<typeof specFields>>;

function issue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: "custom", message, path });
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-3;
}

function sentenceCount(value: string): number {
  return value.split(/[.!?](?:\s|$)/).filter((part) => part.trim().length > 0).length;
}

/** Where a picture sits on the timeline, or undefined for identity references. */
function anchorSeconds(picture: H3Picture, spec: SpecShape): number | undefined {
  if (picture.role === "identity" || !picture.shot) return undefined;
  const shot = spec.shots[picture.shot - 1];
  if (!shot) return undefined;
  if (picture.role === "first_frame") return shot.startSeconds;
  if (picture.role === "last_frame") return spec.durationSeconds;
  return picture.atSeconds;
}

function freeTextFields(spec: SpecShape): { path: (string | number)[]; value: string }[] {
  const fields: { path: (string | number)[]; value: string }[] = [
    { path: ["style"], value: spec.style },
    { path: ["soundscape"], value: spec.soundscape },
    { path: ["music"], value: spec.music },
  ];
  spec.subjects.forEach((subject, i) => {
    for (const key of ["name", "description", "wardrobe", "voice"] as const) {
      const value = subject[key];
      if (value) fields.push({ path: ["subjects", i, key], value });
    }
  });
  spec.pictures.forEach((picture, i) => {
    if (picture.shows) fields.push({ path: ["pictures", i, "shows"], value: picture.shows });
  });
  spec.shots.forEach((shot, i) => {
    for (const key of ["framing", "setting", "lighting", "action", "product", "sound"] as const) {
      const value = shot[key];
      if (value) fields.push({ path: ["shots", i, key], value });
    }
    if (shot.camera.detail) fields.push({ path: ["shots", i, "camera", "detail"], value: shot.camera.detail });
  });
  spec.dialogue.forEach((entry, i) => {
    if (entry.tone) fields.push({ path: ["dialogue", i, "tone"], value: entry.tone });
  });
  return fields;
}

/** Rules every H3 spec follows, whichever renderer reads it. */
function checkSpec(spec: SpecShape, context: z.RefinementCtx): void {
  const subjectIds = new Set<string>();
  spec.subjects.forEach((subject, i) => {
    if (subjectIds.has(subject.id)) issue(context, ["subjects", i, "id"], `Subject id "${subject.id}" is used twice.`);
    subjectIds.add(subject.id);
  });

  const frames = framesForSeconds(spec.durationSeconds);
  spec.shots.forEach((shot, i) => {
    const expectedStart = i === 0 ? 0 : spec.shots[i - 1].endSeconds;
    if (!near(shot.startSeconds, expectedStart)) {
      issue(context, ["shots", i, "startSeconds"], i === 0 ? "Shot 1 starts at 0 seconds." : `Shot ${i + 1} starts where shot ${i} ends (${expectedStart} s); cut times increase with no gaps.`);
    }
    if (shot.endSeconds <= shot.startSeconds) issue(context, ["shots", i, "endSeconds"], `Shot ${i + 1} ends after it starts.`);
    if (shot.endSeconds > spec.durationSeconds + 1e-3) issue(context, ["shots", i, "endSeconds"], `Shot ${i + 1} ends at ${shot.endSeconds} s, past the ${spec.durationSeconds} s duration.`);
    shot.subjects.forEach((id, j) => {
      if (!subjectIds.has(id)) issue(context, ["shots", i, "subjects", j], `Shot ${i + 1} shows unknown subject "${id}".`);
    });
    if (shot.product && !spec.product) issue(context, ["shots", i, "product"], "A product placement needs the product card (product.name and its appearance).");
    if (shot.camera.move === "static" && (shot.camera.amplitude || shot.camera.speed)) {
      issue(context, ["shots", i, "camera"], "A static shot has no amplitude or speed.");
    }
  });
  const last = spec.shots.at(-1);
  if (last && !near(last.endSeconds, spec.durationSeconds)) {
    issue(context, ["shots", spec.shots.length - 1, "endSeconds"], `The last shot ends at the duration (${spec.durationSeconds} s).`);
  }

  const firstFrameShots = new Set<number>();
  spec.pictures.forEach((picture, i) => {
    const path = ["pictures", i];
    if (picture.index !== i + 1) issue(context, [...path, "index"], `Pictures are listed in ref_images slot order: entry ${i + 1} is <Picture ${i + 1}>.`);
    if (picture.subject && !subjectIds.has(picture.subject)) issue(context, [...path, "subject"], `<Picture ${picture.index}> shows unknown subject "${picture.subject}".`);
    if (picture.role === "identity") {
      if (!picture.subject) issue(context, [...path, "subject"], `<Picture ${picture.index}> is an identity reference, so it names the subject it defines.`);
      if (picture.shot || picture.atSeconds !== undefined) issue(context, [...path, "role"], `<Picture ${picture.index}> is an identity reference; only frame anchors take a shot or time.`);
      return;
    }
    if (picture.sheet) issue(context, [...path, "sheet"], `<Picture ${picture.index}> is a frame anchor; a reference sheet is an identity reference.`);
    if (!picture.shows) issue(context, [...path, "shows"], `<Picture ${picture.index}> needs a short description of what it shows.`);
    const shot = picture.shot ? spec.shots[picture.shot - 1] : undefined;
    if (!shot) {
      issue(context, [...path, "shot"], `<Picture ${picture.index}> anchors a shot that exists (1 to ${spec.shots.length}).`);
      return;
    }
    if (picture.role === "first_frame") {
      if (firstFrameShots.has(picture.shot!)) issue(context, [...path, "shot"], `Shot ${picture.shot} already has a first frame.`);
      firstFrameShots.add(picture.shot!);
      if (picture.atSeconds !== undefined && !near(picture.atSeconds, shot.startSeconds)) {
        issue(context, [...path, "atSeconds"], `A first frame sits at its shot's start (${shot.startSeconds} s); use a keyframe for another moment.`);
      }
    }
    if (picture.role === "last_frame" && picture.shot !== spec.shots.length) issue(context, [...path, "shot"], "A last frame belongs to the final shot.");
    if (picture.role === "keyframe") {
      if (picture.atSeconds === undefined) {
        issue(context, [...path, "atSeconds"], `Keyframe <Picture ${picture.index}> needs atSeconds.`);
        return;
      }
      if (picture.atSeconds < shot.startSeconds || picture.atSeconds >= shot.endSeconds) {
        issue(context, [...path, "atSeconds"], `Keyframe <Picture ${picture.index}> at ${picture.atSeconds} s is outside shot ${picture.shot} (${shot.startSeconds} to ${shot.endSeconds} s).`);
      }
    }
    const at = anchorSeconds(picture, spec);
    if (picture.role !== "last_frame" && at !== undefined && frameIndexAt(at) + GUIDE_FRAMES > frames) {
      issue(context, [...path, "atSeconds"], `<Picture ${picture.index}> at frame ${frameIndexAt(at)} plus its ${GUIDE_FRAMES}-frame guide runs past the ${frames}-frame video.`);
    }
  });

  for (const field of freeTextFields(spec)) {
    for (const match of field.value.matchAll(/<([^<>]*)>/g)) {
      const picture = /^Picture (\d+)$/.exec(match[1]);
      if (!picture) issue(context, field.path, `Only <Picture N> tags may appear in text; the renderer adds every other tag (found <${match[1]}>).`);
      else if (Number(picture[1]) > spec.pictures.length) issue(context, field.path, `<Picture ${picture[1]}> does not exist; this spec has ${spec.pictures.length} picture(s).`);
    }
    if (/["“”]/.test(field.value)) issue(context, field.path, "H3 renders double-quoted words as on-screen text; put spoken words in dialogue and leave quotes out.");
  }
  if (sentenceCount(spec.soundscape) > 4) issue(context, ["soundscape"], "The soundscape is one to four sentences.");
  if (spec.music !== "N/A" && sentenceCount(spec.music) > 3) issue(context, ["music"], "Music is one to three sentences, or N/A.");

  const wordsPerShot = new Map<number, number>();
  spec.dialogue.forEach((entry, i) => {
    const path = ["dialogue", i];
    if (!subjectIds.has(entry.speaker)) issue(context, [...path, "speaker"], `Unknown speaker "${entry.speaker}".`);
    const shot = spec.shots[entry.shot - 1];
    if (!shot) {
      issue(context, [...path, "shot"], `Line ${i + 1} is in shot ${entry.shot}, which does not exist.`);
      return;
    }
    if (i > 0 && entry.shot < spec.dialogue[i - 1].shot) issue(context, [...path, "shot"], "Dialogue is listed in playback order.");
    if (!entry.offscreen && !shot.subjects.includes(entry.speaker)) {
      issue(context, [...path, "offscreen"], `${entry.speaker} is not in shot ${entry.shot}; add them to the shot or mark the line offscreen.`);
    }
    if (/[<>]/.test(entry.text)) issue(context, [...path, "text"], "Spoken words cannot contain angle brackets.");
    if (/\.\.\.|…/.test(entry.text)) issue(context, [...path, "text"], "Ellipses blur H3 speech; use a comma or a period.");
    wordsPerShot.set(entry.shot, (wordsPerShot.get(entry.shot) ?? 0) + wordCount(entry.text));
  });
  for (const [shotNumber, words] of wordsPerShot) {
    const shot = spec.shots[shotNumber - 1];
    const seconds = shot.endSeconds - shot.startSeconds;
    if (words / WORDS_PER_SECOND > seconds + 1e-3) {
      const needed = Math.ceil((words / WORDS_PER_SECOND) * 10) / 10;
      issue(context, ["dialogue"], `Shot ${shotNumber} holds ${words} spoken words, about ${needed} s at ${WORDS_PER_SECOND} words per second; the shot is ${Math.round(seconds * 1000) / 1000} s. Shorten the lines or lengthen the shot.`);
    }
  }
  spec.subjects.forEach((subject, i) => {
    const used = spec.shots.some((shot) => shot.subjects.includes(subject.id)) || spec.dialogue.some((entry) => entry.speaker === subject.id);
    if (!used) issue(context, ["subjects", i], `Subject "${subject.id}" is never in a shot or speaking.`);
  });
}

/** A structured H3 shot spec; the mode-specific schemas below add their own rules. */
export const H3ShotSpecSchema = z.object(specFields).strict().superRefine(checkSpec);
export type H3ShotSpec = z.infer<typeof H3ShotSpecSchema>;
export type H3ShotSpecInput = z.input<typeof H3ShotSpecSchema>;

/** Full-reference mode: every subject comes from a reference image, so nothing about a person is invented. */
export const H3ReferenceSpecSchema = H3ShotSpecSchema.superRefine((spec, context) => {
  if (spec.pictures.length === 0) issue(context, ["pictures"], "Full-reference mode needs at least one <Picture N>.");
  spec.subjects.forEach((subject, i) => {
    if (!spec.pictures.some((picture) => picture.subject === subject.id)) {
      issue(context, ["subjects", i], `Subject "${subject.id}" needs a picture that shows them (identity or frame anchor with subject "${subject.id}").`);
    }
  });
});

function checkSingleShot(spec: H3ShotSpec, context: z.RefinementCtx): void {
  if (spec.shots.length !== 1) issue(context, ["shots"], "Image to video renders one shot; use the reference workflow or a chain for cuts.");
  const [first, second, ...rest] = spec.pictures;
  if (!first || first.role !== "first_frame" || first.shot !== 1) issue(context, ["pictures", 0], "Image to video starts from <Picture 1> as the first frame of shot 1.");
  if (second && second.role !== "last_frame") issue(context, ["pictures", 1, "role"], "The base modes take only a first frame and an optional last frame; identity references and keyframes need the reference workflow.");
  if (rest.length > 0) issue(context, ["pictures"], "The base modes take at most two pictures.");
}

/** Base image to video (I2VA), or first and last frame (FL2VA) when <Picture 2> is a last frame. */
export const H3SingleShotSpecSchema = H3ShotSpecSchema.superRefine(checkSingleShot);

/** Segments chained on each segment's last frame: segment 2 starts from segment 1's last frame. */
export const H3ChainSpecSchema = z
  .object({ segments: z.array(H3SingleShotSpecSchema).min(2).max(6) })
  .strict()
  .superRefine((chain, context) => {
    if (chain.segments.length === 0) return;
    const first = new Map(chain.segments[0].subjects.map((subject) => [subject.id, subject]));
    chain.segments.forEach((segment, s) => {
      if (segment.pictures.some((picture) => picture.role === "last_frame") && s < chain.segments.length - 1) {
        issue(context, ["segments", s, "pictures"], "Only the final segment can pin a last frame; earlier segments end freely so the next can continue from their last frame.");
      }
      segment.subjects.forEach((subject, i) => {
        const original = first.get(subject.id);
        if (!original) {
          if (s > 0) issue(context, ["segments", s, "subjects", i], `Subject "${subject.id}" is not in segment 1; a chain keeps the same people.`);
          return;
        }
        if (original.description !== subject.description || original.wardrobe !== subject.wardrobe || original.voice !== subject.voice) {
          issue(context, ["segments", s, "subjects", i], `Subject "${subject.id}" keeps the same description, wardrobe, and voice in every segment.`);
        }
      });
    });
  });
export type H3ChainSpecInput = z.input<typeof H3ChainSpecSchema>;

/** A frame anchor for the workflow: which picture and at which `frame_idx`. */
export interface H3Anchor {
  picture: number;
  role: Exclude<H3PictureRole, "identity">;
  frameIdx: number;
}

export type H3Render = { ok: true; prompt: string; frames: number; anchors: H3Anchor[] } | { ok: false; errors: string[] };
export type H3ChainRender = { ok: true; segments: { prompt: string; frames: number }[] } | { ok: false; errors: string[] };

function errorsOf(error: z.ZodError): string[] {
  return error.issues.map((entry) => (entry.path.length ? `${entry.path.join(".")}: ${entry.message}` : entry.message));
}

function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function clause(value: string): string {
  return value.trim().replace(/[.!]+$/, "");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function withArticle(noun: string): string {
  if (/^(a|an|the)\s/i.test(noun)) return noun;
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/** A fragment continuing a sentence: lowercase first letter unless it starts with a name or a tag. */
function continuing(value: string, names: string[]): string {
  const text = clause(value);
  if (text.startsWith("<") || names.some((name) => new RegExp(`^${escapeRegExp(name)}\\b`).test(text))) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listOf(items: string[]): string {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

const CAMERA_VERBS: Record<H3CameraMove, string> = {
  static: "holds a static shot",
  push_in: "pushes in",
  pull_out: "pulls out",
  zoom_in: "zooms in",
  zoom_out: "zooms out",
  pan_left: "pans left",
  pan_right: "pans right",
  truck_left: "trucks left",
  truck_right: "trucks right",
  tilt_up: "tilts up",
  tilt_down: "tilts down",
  pedestal_up: "pedestals up",
  pedestal_down: "pedestals down",
  arc: "moves in an arc shot",
  tracking: "follows in a tracking shot",
  shake_slightly: "shakes slightly like a handheld phone",
};

/** The guide's camera form: motion type, then amplitude and speed only when they matter. */
function cameraSentence(camera: H3Camera, rewrite: (text: string) => string): string {
  const amplitude = camera.amplitude ? ` with ${camera.amplitude} amplitude` : "";
  const speed = camera.speed ? ` at ${camera.speed} speed` : "";
  const detail = camera.detail ? ` ${clause(rewrite(camera.detail))}` : "";
  return `The camera ${CAMERA_VERBS[camera.move]}${amplitude}${speed}${detail}.`;
}

/** How a renderer refers to subjects and rewrites free text. */
interface Voice {
  /** "<Subject 1>" in full-reference mode, the subject's name in the base modes. */
  ref: (id: string) => string;
  rewrite: (text: string) => string;
  names: string[];
}

function productSentence(spec: H3ShotSpec, shot: H3Shot, voice: Voice): string {
  if (!shot.product || !spec.product) return "";
  const look = productAppearance(spec.product);
  return `The product, ${look}, its surface plain and unmarked, is ${continuing(voice.rewrite(shot.product), voice.names)}.`;
}

function speakerIds(spec: H3ShotSpec): Map<string, number> {
  const ids = new Map<string, number>();
  for (const entry of spec.dialogue) if (!ids.has(entry.speaker)) ids.set(entry.speaker, ids.size + 1);
  return ids;
}

/** The shot's lines in the guide's form: speaker, ID, delivery outside `<d>`, the words inside it. */
function dialogueSentences(spec: H3ShotSpec, shotNumber: number, voice: Voice, spoken: Set<string>): string[] {
  const ids = speakerIds(spec);
  const shot = spec.shots[shotNumber - 1];
  const lines = spec.dialogue.filter((entry) => entry.shot === shotNumber);
  return lines.map((entry, i) => {
    const subject = spec.subjects.find((candidate) => candidate.id === entry.speaker)!;
    const who = voice.ref(subject.id);
    const first = !spoken.has(subject.id);
    spoken.add(subject.id);
    const timbre = first && subject.voice ? `, speaking in ${continuing(subject.voice, voice.names)},` : "";
    const words = `<d>[${spec.language}] ${sentence(entry.text)}</d>`;
    const inFrame = shot.subjects.includes(subject.id);
    if (entry.offscreen) {
      const tone = entry.tone ? `, ${clause(entry.tone)}` : "";
      return `${who} (S${ids.get(subject.id)})${timbre} says in an off-screen voiceover${tone}: ${words}${inFrame ? ` while ${who}'s lips remain completely closed.` : ""}`;
    }
    const tone = entry.tone ? ` ${clause(entry.tone)}` : "";
    const lastForSpeaker = !lines.slice(i + 1).some((later) => later.speaker === entry.speaker && !later.offscreen);
    return `${who} (S${ids.get(subject.id)})${timbre} says${tone}: ${words}${lastForSpeaker ? ` ${who} finishes the line and goes quiet with lips closed.` : ""}`;
  });
}

function anchorsOf(spec: H3ShotSpec): H3Anchor[] {
  const frames = framesForSeconds(spec.durationSeconds);
  return spec.pictures.flatMap((picture) => {
    if (picture.role === "identity") return [];
    const frameIdx = picture.role === "last_frame" ? frames - 1 : frameIndexAt(anchorSeconds(picture, spec) ?? 0);
    return [{ picture: picture.index, role: picture.role, frameIdx }];
  });
}

function result(spec: H3ShotSpec, prompt: string): H3Render {
  if (prompt.length > H3_PROMPT_LIMIT) return { ok: false, errors: [`The rendered prompt is ${prompt.length} characters; the H3 limit here is ${H3_PROMPT_LIMIT}. Shorten the shot text.`] };
  return { ok: true, prompt, frames: framesForSeconds(spec.durationSeconds), anchors: anchorsOf(spec) };
}

function shotsWith(spec: H3ShotSpec, id: string): number[] {
  return spec.shots.flatMap((shot, i) => (shot.subjects.includes(id) ? [i + 1] : []));
}

function shotTags(numbers: number[]): string {
  return numbers.map((n) => `[Shot ${n}]`).join(", ");
}

function anchorLabel(picture: H3Picture, spec: H3ShotSpec): string {
  if (picture.role === "first_frame") return `[Shot ${picture.shot}] first frame`;
  if (picture.role === "last_frame") return `[Shot ${picture.shot}] last frame`;
  return `[Shot ${picture.shot}] keyframe at ${h3Timestamp(anchorSeconds(picture, spec) ?? 0)}`;
}

/**
 * The full-reference prompt for the multi-frame reference workflow: subject definitions, summary,
 * retention analysis, the timestamped shot description, and the two audio sections.
 */
export function renderH3Prompt(input: H3ShotSpecInput): H3Render {
  const parsed = H3ReferenceSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: errorsOf(parsed.error) };
  const spec = parsed.data;
  const labels = new Map(spec.subjects.map((subject, i) => [subject.id, `<Subject ${i + 1}>`]));
  const named = [...spec.subjects].sort((a, b) => b.name.length - a.name.length);
  const voice: Voice = {
    ref: (id) => labels.get(id)!,
    names: [],
    rewrite: (text) => {
      let value = spec.product ? withoutProductName(text, spec.product) : text;
      for (const subject of named) value = value.replace(new RegExp(`\\b${escapeRegExp(subject.name)}\\b`, "g"), labels.get(subject.id)!);
      return value;
    },
  };
  const tag = (picture: H3Picture) => `<Picture ${picture.index}>`;

  const definitions: string[] = [];
  for (const subject of spec.subjects) {
    const sources = spec.pictures.filter((picture) => picture.subject === subject.id).map(tag);
    definitions.push(`${voice.ref(subject.id)} is the person in ${listOf(sources)}. ${sentence(subject.description)} ${voice.ref(subject.id)} wears ${clause(subject.wardrobe)} throughout.`);
  }
  for (const picture of spec.pictures) {
    if (picture.role === "identity" && picture.sheet) {
      definitions.push(`${tag(picture)} is a character reference sheet of ${voice.ref(picture.subject!)} with a large portrait panel, a full-body front view, and a full-body back view.`);
    } else if (picture.role !== "identity") {
      const shows = continuing(voice.rewrite(picture.shows!), []);
      const where = picture.role === "keyframe" ? `the keyframe of [Shot ${picture.shot}] at ${h3Timestamp(picture.atSeconds!)}` : `the ${picture.role === "first_frame" ? "first" : "last"} frame of [Shot ${picture.shot}]`;
      definitions.push(`${tag(picture)} is ${where}, showing ${shows}.`);
    }
  }

  const frameAnchors = spec.pictures.filter((picture) => picture.role !== "identity");
  const types = [frameAnchors.length ? "keyframe completion" : "", spec.subjects.length ? "reference generation" : ""].filter(Boolean);
  const flow = spec.shots.map((shot, i) => `[Shot ${i + 1}] ${clause(shot.framing)}, ${continuing(voice.rewrite(shot.setting), [])}`).join("; ");
  const roles = spec.pictures.map((picture) => {
    if (picture.role === "identity") return `${tag(picture)} defines ${voice.ref(picture.subject!)}`;
    if (picture.role === "keyframe") return `${tag(picture)} is the keyframe of [Shot ${picture.shot}] at ${h3Timestamp(picture.atSeconds!)}`;
    return `${tag(picture)} is the ${picture.role === "first_frame" ? "first" : "last"} frame of [Shot ${picture.shot}]`;
  });
  const people = spec.subjects.length ? ` with ${listOf(spec.subjects.map((subject) => voice.ref(subject.id)))}` : "";
  const summary = `[${types.join(" + ")}] The target video runs ${spec.durationSeconds} seconds in ${spec.shots.length} shot${spec.shots.length === 1 ? "" : "s"}${people}: ${flow}. ${capitalize(listOf(roles))}.`;

  const retention: string[] = [];
  for (const subject of spec.subjects) {
    const appears = shotsWith(spec, subject.id);
    const heard = spec.dialogue.filter((entry) => entry.speaker === subject.id).map((entry) => entry.shot);
    const where = appears.length ? `appears in ${shotTags(appears)}` : `heard in ${shotTags([...new Set(heard)])}`;
    retention.push(`${voice.ref(subject.id)} (${where}): fully_preserved - the face, hair, skin, and distinguishing details are retained, with ${clause(subject.wardrobe)} in every shot.`);
  }
  for (const picture of spec.pictures) {
    if (picture.role === "identity" && picture.sheet) {
      retention.push(`${tag(picture)} (identity reference sheet): fully_preserved - ${voice.ref(picture.subject!)} keeps the face from the portrait panel and the build from the full-body views.`);
    } else if (picture.role !== "identity") {
      const at = h3Timestamp(picture.role === "last_frame" ? spec.durationSeconds : anchorSeconds(picture, spec)!);
      retention.push(`${tag(picture)} (${anchorLabel(picture, spec)}): fully_preserved - its composition, pose, and setting are matched at ${at}.`);
    }
  }

  const described = new Set<string>();
  const spoken = new Set<string>();
  const shots = spec.shots.map((shot, i) => {
    const n = i + 1;
    const parts: string[] = [];
    const framing = clause(shot.framing);
    parts.push(n === 1 ? `[Shot 1] ${capitalize(withArticle(framing))}.` : `[Shot ${n}] At ${h3Timestamp(shot.startSeconds)}, the camera cuts to ${withArticle(framing)}.`);
    parts.push(`The setting is ${continuing(voice.rewrite(shot.setting), [])}, ${continuing(voice.rewrite(shot.lighting), [])}.`);
    const pictures = spec.pictures.filter((picture) => picture.shot === n);
    for (const picture of pictures.filter((entry) => entry.role === "first_frame")) {
      parts.push(`The shot begins from ${tag(picture)}, showing ${continuing(voice.rewrite(picture.shows!), [])}.`);
    }
    for (const id of shot.subjects) {
      const subject = spec.subjects.find((candidate) => candidate.id === id)!;
      if (described.has(id)) {
        parts.push(`${voice.ref(id)} is in frame in the same ${clause(subject.wardrobe).replace(/^(a|an|the)\s/i, "")}.`);
        continue;
      }
      described.add(id);
      const identity = spec.pictures.filter((picture) => picture.role === "identity" && picture.subject === id);
      const source = identity.length ? identity : spec.pictures.filter((picture) => picture.subject === id);
      const from = listOf(source.map((picture) => (picture.sheet ? `the portrait panel of ${tag(picture)}` : tag(picture))));
      parts.push(`${voice.ref(id)} is in frame, wearing ${clause(subject.wardrobe)}, with the face and hair from ${from}.`);
    }
    parts.push(sentence(voice.rewrite(shot.action)));
    const product = productSentence(spec, shot, voice);
    if (product) parts.push(product);
    parts.push(cameraSentence(shot.camera, voice.rewrite));
    for (const picture of pictures.filter((entry) => entry.role === "keyframe")) {
      parts.push(`At ${h3Timestamp(picture.atSeconds!)}, the shot's keyframe corresponds to ${tag(picture)}, showing ${continuing(voice.rewrite(picture.shows!), [])}.`);
    }
    parts.push(...dialogueSentences(spec, n, voice, spoken));
    if (shot.sound) parts.push(sentence(voice.rewrite(shot.sound)));
    for (const picture of pictures.filter((entry) => entry.role === "last_frame")) {
      parts.push(`The shot ends on ${tag(picture)}, showing ${continuing(voice.rewrite(picture.shows!), [])}.`);
    }
    return parts.join(" ");
  });

  const prompt = [
    `subject_definitions:\n${definitions.join("\n")}`,
    `summary:\n${summary}`,
    `retention_analysis:\n${retention.join("\n")}`,
    `detailed_description:\nThe target video uses a ${clause(spec.style)} style.\n${shots.join("\n")}`,
    `overall_soundscape:\n${sentence(spec.soundscape)}`,
    `non_diegetic_music:\n${spec.music === "N/A" ? "N/A" : sentence(spec.music)}`,
  ].join("\n\n");
  return result(spec, prompt);
}

function baseVoice(spec: H3ShotSpec): Voice {
  const names = spec.subjects.map((subject) => subject.name);
  return {
    ref: (id) => spec.subjects.find((subject) => subject.id === id)!.name,
    names,
    rewrite: (text) => (spec.product ? withoutProductName(text, spec.product) : text),
  };
}

interface BaseOptions {
  /** Segment 2 onward of a chain: <Picture 1> is the previous segment's last frame. */
  continues?: boolean;
  /** The next segment's opening action, which this segment's last second sets up. */
  next?: string;
}

/** The base-mode body (I2VA or FL2VA) for a single-shot spec. */
function renderBase(spec: H3ShotSpec, options: BaseOptions = {}): string {
  const voice = baseVoice(spec);
  const shot = spec.shots[0];
  const [first, last] = spec.pictures;
  const frames = framesForSeconds(spec.durationSeconds);
  const instruction = last
    ? `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${(frames / H3_FPS).toFixed(2)}-second mark of the target video.`
    : "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
  const opening = options.continues ? `continues from <Picture 1>, the last frame of the previous segment` : "begins from <Picture 1>";
  const parts: string[] = [
    `[Shot 1] ${capitalize(clause(spec.style))} style, ${withArticle(clause(shot.framing))} ${opening}, showing ${continuing(voice.rewrite(first.shows!), voice.names)}.`,
  ];
  // The first frame carries identity, wardrobe, product, set, and light: point at it, never restate it.
  for (const id of shot.subjects) {
    const subject = spec.subjects.find((candidate) => candidate.id === id)!;
    if (first.subject === id) {
      parts.push(`${subject.name} shown in <Picture 1> keeps the face, hair, clothing, and position exactly as in <Picture 1>.`);
    } else {
      parts.push(sentence(subject.description), `${subject.name} wears ${clause(subject.wardrobe)}.`);
    }
  }
  parts.push("The setting and light stay exactly as in <Picture 1>.");
  parts.push(sentence(voice.rewrite(shot.action)));
  if (shot.product && spec.product) parts.push(`The product shown in <Picture 1> keeps its shape and proportions, ${continuing(voice.rewrite(shot.product), voice.names)}.`);
  parts.push(cameraSentence(shot.camera, voice.rewrite));
  parts.push(...dialogueSentences(spec, 1, voice, new Set()));
  // Without an on-camera line, H3 still tends to mouth words; keep the lips shut.
  for (const id of shot.subjects) {
    const speaks = spec.dialogue.some((entry) => entry.speaker === id && !entry.offscreen);
    const voiceover = spec.dialogue.some((entry) => entry.speaker === id && entry.offscreen);
    if (!speaks && !voiceover) parts.push(`${spec.subjects.find((candidate) => candidate.id === id)!.name}'s lips remain closed throughout.`);
  }
  if (shot.sound) parts.push(sentence(voice.rewrite(shot.sound)));
  if (last) parts.push(`The motion settles into the pose, framing, and composition established by Picture 2 at the end of the shot, showing ${continuing(voice.rewrite(last.shows!), voice.names)}.`);
  if (options.next) parts.push(`In the last second the motion eases into a steady pose with the same framing, clothing, and light, setting up the next moment: ${clause(voice.rewrite(options.next))}.`);
  const music = spec.music === "N/A" ? "N/A" : sentence(spec.music);
  return `${instruction}\n\nintegrated_multimodal_description: ${parts.join(" ")}\n\noverall_soundscape: ${sentence(spec.soundscape)}\n\nnon_diegetic_music: ${music}`;
}

/**
 * The base image-to-video prompt for `minimax-h3-i2v`: <Picture 1> is the first frame of one shot.
 * With a last frame as <Picture 2> it renders the first-and-last form for `minimax-h3-flf2v`.
 */
export function renderH3SingleShot(input: H3ShotSpecInput): H3Render {
  const parsed = H3SingleShotSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: errorsOf(parsed.error) };
  return result(parsed.data, renderBase(parsed.data));
}

/**
 * Image-to-video segments for talking content longer than one clip, chained on last frames: each
 * segment after the first starts from the previous segment's last frame (extracted at
 * {@link lastFrameIndex}), and each segment but the last ends on a steady pose that sets up the
 * next segment's action, so the seam joins two matching frames.
 */
export function renderH3Chain(input: H3ChainSpecInput): H3ChainRender {
  const parsed = H3ChainSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: errorsOf(parsed.error) };
  const segments = parsed.data.segments.map((spec, s, all) => {
    const next = all[s + 1]?.shots[0].action;
    return { spec, prompt: renderBase(spec, { continues: s > 0, next }) };
  });
  const long = segments.findIndex((segment) => segment.prompt.length > H3_PROMPT_LIMIT);
  if (long >= 0) return { ok: false, errors: [`segments.${long}: the rendered prompt is ${segments[long].prompt.length} characters; the H3 limit here is ${H3_PROMPT_LIMIT}.`] };
  return { ok: true, segments: segments.map(({ spec, prompt }) => ({ prompt, frames: framesForSeconds(spec.durationSeconds) })) };
}
