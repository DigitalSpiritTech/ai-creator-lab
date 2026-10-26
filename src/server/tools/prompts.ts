/**
 * Prompt builders for the generation wrappers, following the character-bible, ugc-script, and
 * ltx-prompting skills. Pure functions; the creative-prompts workstream (C4) refines the wording.
 * @packageDocumentation
 */
import type { CharacterBible } from "@/lib/domain/library";
import type { Beat } from "@/lib/domain/script";

export const NO_TEXT = "No text, captions, logos, or watermarks in the image.";

/** The reference sheet prompt from the character-bible skill. */
export function referenceSheetPrompt(bible: CharacterBible, wardrobe: string): string {
  return [
    "Character reference sheet of one consistent person, on a deep neutral grey (#3a3a3c) seamless studio background, clean editorial layout in three vertical columns read left to right, identical identity, lighting, and color grading in every panel.",
    "Column 1, largest, about a third of the width: chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights in both eyes, natural skin texture with subtle imperfections, no mirror symmetry.",
    "Column 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins.",
    "Column 3: full-body back view, same pose mirrored, showing hair fall, posture, and garment fit.",
    `The person is the person in reference image 1 (face, hair, skin, eyes) with the build of reference image 2. ${bible.visualCore} Wardrobe in every panel: ${wardrobe}.`,
    "Soft even studio light, large diffused key with gentle fill, neutral white balance, true-to-life skin, 85mm look, tack-sharp detail. No text, no labels, no logos, no colored rim light, no 3D render look.",
  ].join("\n");
}

export interface StillPromptParts {
  beat: Beat;
  bible?: CharacterBible;
  wardrobe?: string | null;
  /** How the character is referenced: one sheet, or a face plus an optional body image. */
  character?: { mode: "sheet"; image: number } | { mode: "face"; face: number; body?: number };
  product?: { name: string; image?: number };
}

/** A start-frame prompt for one beat, numbering reference images as they are attached. */
export function stillPrompt(parts: StillPromptParts): string {
  const { beat, bible, character, product } = parts;
  const lines: string[] = [];
  if (bible && character) {
    lines.push(bible.visualCore);
    if (character.mode === "sheet") {
      lines.push(`The person shown in the character reference sheet, reference image ${character.image}${parts.wardrobe ? `, wearing ${parts.wardrobe}` : ""}.`);
    } else {
      const body = character.body ? ` with the build of reference image ${character.body}` : "";
      lines.push(`The person in reference image ${character.face}${body}${parts.wardrobe ? `, wearing ${parts.wardrobe}` : ""}.`);
    }
  }
  lines.push(beat.visual);
  if (beat.setting) lines.push(`Setting: ${beat.setting}.`);
  if (product) {
    lines.push(
      product.image
        ? `The product in reference image ${product.image} is the ${product.name}${beat.productVisible ? ", clearly visible and recognizable" : ""}.`
        : `The product is the ${product.name}.`,
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

/** An LTX image-to-video prompt for one beat: subject, one action, camera, sound, dialogue, constraint. */
export function clipPrompt(beat: Beat): string {
  if (beat.type === "talking") {
    return [
      `${beat.visual.replace(/\.$/, "")}, speaking to the camera with an easy smile, small natural head movement, static phone camera.`,
      beat.setting ? `Quiet ambient sound of ${beat.setting}.` : "Quiet ambient room sound.",
      `The person says, "${beat.spokenLine}"`,
      "No text on screen. The person's face and clothing stay consistent.",
    ].join(" ");
  }
  const camera = beat.type === "broll" ? "slow push-in" : "static camera";
  return [
    `${beat.visual.replace(/\.$/, "")}, ${camera}.`,
    beat.setting ? `Ambient sound of ${beat.setting}, no speech, ambient sound only.` : "No speech, ambient sound only.",
    "No text on screen.",
  ].join(" ");
}

/** A refinement edit that changes one thing and keeps the rest. */
export function refinePrompt(instruction: string): string {
  return `${instruction.replace(/\.$/, "")}. Change only that; keep the person, product, composition, lighting, and background otherwise identical. ${NO_TEXT}`;
}
