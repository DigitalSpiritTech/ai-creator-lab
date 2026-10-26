/**
 * Prompt templates for every generation step, following the character-bible, ugc-script, and
 * ltx-prompting skills. Pure functions of the bible, product, set, beat, and wardrobe; each result
 * stays under {@link PROMPT_LIMIT} characters for the Z-Image, Qwen Image Edit, Nano Banana, and
 * LTX recipes.
 * @packageDocumentation
 */
import type { CharacterBible } from "@/lib/domain/library";
import type { Beat } from "@/lib/domain/script";

/** The longest prompt any template may produce. */
export const PROMPT_LIMIT = 2000;

export const NO_TEXT = "No text, captions, logos, or watermarks in the image.";

/** How a face lock is proposed: four text-to-image candidates, square. */
export const FACE_LOCK = { capability: "text_to_image", aspectRatio: "1:1", count: 4 } as const;

/** How a body reference is proposed: an edit of the locked face, vertical. */
export const BODY_REFERENCE = { capability: "image_edit", aspectRatio: "9:16", count: 2 } as const;

/** Ends a fragment with exactly one period. */
function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Drops a trailing period so the fragment can continue with a clause. */
function clause(value: string): string {
  return value.trim().replace(/[.!]+$/, "");
}

/** A fragment placed mid-sentence: no trailing period, lowercase first letter. */
function inline(value: string): string {
  const text = clause(value);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The face lock prompt. Z-Image ignores "three-quarter view" on its own, so the turn is spelled
 * out as a thirty-degree head turn with what it does to the cheek and ear.
 */
export function facePrompt(bible: Pick<CharacterBible, "visualCore">): string {
  return [
    sentence(bible.visualCore),
    "Portrait, head and shoulders, head turned about thirty degrees to the left so the far cheek narrows and the near ear shows, eyes toward the camera, neutral expression with a hint of a smile, soft natural window light, plain light gray background, no accessories beyond those described, photographic, 85mm look.",
    NO_TEXT,
  ].join(" ");
}

/** The body reference prompt, an edit of the locked face (the only reference image). */
export function bodyPrompt(bible: Pick<CharacterBible, "build">): string {
  return [
    "Same person as the reference image, identical face and hair.",
    `Build: ${sentence(bible.build)}`,
    "Three-quarter view full-body standing pose, body turned about thirty degrees from the camera, relaxed, arms at sides, fitted neutral athleticwear (plain fitted tee and leggings or shorts), simple trainers, head to toe inside the frame, plain light gray background, even soft light, photographic.",
    NO_TEXT,
  ].join(" ");
}

/** The reference sheet prompt from the character-bible skill, verbatim. */
export function referenceSheetPrompt(bible: Pick<CharacterBible, "visualCore">, wardrobe: string): string {
  return [
    "Character reference sheet of one consistent person, on a deep neutral grey (#3a3a3c) seamless studio background, clean editorial layout in three vertical columns read left to right, identical identity, lighting, and color grading in every panel.",
    "Column 1, largest, about a third of the width: chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights in both eyes, natural skin texture with subtle imperfections, no mirror symmetry.",
    "Column 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins.",
    "Column 3: full-body back view, same pose mirrored, showing hair fall, posture, and garment fit.",
    `The person is the person in reference image 1 (face, hair, skin, eyes) with the build of reference image 2. ${sentence(bible.visualCore)} Wardrobe in every panel: ${clause(wardrobe)}.`,
    "Soft even studio light, large diffused key with gentle fill, neutral white balance, true-to-life skin, 85mm look, tack-sharp detail. No text, no labels, no logos, no colored rim light, no 3D render look.",
  ].join("\n");
}

export interface StillPromptParts {
  beat: Beat;
  bible?: Pick<CharacterBible, "visualCore">;
  wardrobe?: string | null;
  /** How the character is referenced: one sheet, or a face plus an optional body image. */
  character?: { mode: "sheet"; image: number } | { mode: "face"; face: number; body?: number };
  product?: { name: string; image?: number };
  /** A Library set, referenced by image number when it has one. */
  set?: { name: string; image?: number };
}

const STILL_FRAMING: Record<Beat["type"], string> = {
  talking: "Mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking.",
  broll: "Close detail shot.",
  textcard: "Simple uncluttered composition with calm empty space in the upper third for a caption added later.",
};

/**
 * A start-frame prompt for one beat. Reference images are numbered as the tool attaches them: the
 * approved sheet as image 1 (or the face, then the body), then the product, then the set.
 */
export function stillPrompt(parts: StillPromptParts): string {
  const { beat, bible, character, product, set } = parts;
  const wearing = parts.wardrobe ? `, wearing ${inline(parts.wardrobe)}` : "";
  const lines: string[] = [];
  if (bible && character) {
    lines.push(sentence(bible.visualCore));
    if (character.mode === "sheet") {
      lines.push(`The person shown in the character reference sheet, reference image ${character.image}${wearing}.`);
    } else {
      const body = character.body ? ` with the build of reference image ${character.body}` : "";
      lines.push(`The person in reference image ${character.face}${body}${wearing}.`);
    }
  }
  lines.push(STILL_FRAMING[beat.type], sentence(beat.visual));
  if (set?.image) lines.push(`Setting: the location in reference image ${set.image}, ${inline(set.name)}.`);
  else if (set) lines.push(`Setting: ${clause(set.name)}.`);
  else if (beat.setting) lines.push(`Setting: ${clause(beat.setting)}.`);
  if (product) {
    const visible = beat.productVisible ? ", clearly visible and recognizable, true to its shape, color, and label" : "";
    lines.push(
      product.image ? `The product in reference image ${product.image} is the ${clause(product.name)}${visible}.` : `The product is the ${clause(product.name)}${visible}.`,
    );
  }
  if (!character && beat.type !== "talking") lines.push("No faces in frame.");
  lines.push("Vertical 9:16 phone photo, natural light, candid UGC look.", NO_TEXT);
  if (bible && character) {
    lines.push(
      character.mode === "sheet"
        ? "Preserve the person's identity, face, hair, build, and wardrobe exactly as in the sheet."
        : `Preserve the person's identity, face, and hair exactly as in reference image ${character.face}.`,
    );
  }
  return lines.join(" ");
}

export interface ClipPromptParts {
  /** Repeating the still's wardrobe words keeps LTX from drifting the clothing. */
  wardrobe?: string | null;
}

/**
 * An LTX image-to-video prompt for one beat: subject and one action, camera, sound, the spoken line
 * in quotes for talking beats, and the closing constraints. B-roll and text cards get ambient sound
 * only, so LTX does not invent speech.
 */
export function clipPrompt(beat: Beat, parts: ClipPromptParts = {}): string {
  const ambient = beat.setting ? clause(beat.setting) : "the room";
  if (beat.type === "talking") {
    const line = /[.!?]$/.test(beat.spokenLine.trim()) ? beat.spokenLine.trim() : `${beat.spokenLine.trim()}.`;
    return [
      `${clause(beat.visual)}, speaking to the camera with an easy smile, small natural head movement, static phone camera.`,
      parts.wardrobe ? `Wearing ${clause(parts.wardrobe)}.` : "",
      `Quiet ambient sound of ${ambient}.`,
      `The person says, "${line}"`,
      "No text on screen. The person's face and clothing stay consistent.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (beat.type === "broll") {
    return [
      `${clause(beat.visual)}, one simple motion, slow push-in.`,
      `Ambient sound of ${ambient}, no speech, ambient sound only.`,
      "No faces in frame. No text on screen.",
    ].join(" ");
  }
  return [
    `${clause(beat.visual)}, almost still with very subtle natural motion, static camera.`,
    `Soft ambient sound of ${ambient}, no speech, ambient sound only.`,
    "No text on screen.",
  ].join(" ");
}

/** A refinement edit that changes one thing and keeps the rest; sheets also keep their layout. */
export function refinePrompt(instruction: string, kind: "still" | "sheet" = "still"): string {
  const keep =
    kind === "sheet"
      ? "Keep the three-panel layout, the same person in every panel, the wardrobe, and the clean deep grey background otherwise identical."
      : "Keep the person, product, composition, lighting, and background otherwise identical.";
  return `${clause(instruction)}. Change only that. ${keep} ${NO_TEXT}`;
}
