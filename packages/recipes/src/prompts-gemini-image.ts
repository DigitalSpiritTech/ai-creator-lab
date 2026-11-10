/**
 * Image prompts for the Nano Banana family (Gemini image on Vertex AI, through Comfy Router),
 * rendered from a shot spec. Google's guidance for Gemini image generation: describe the scene in a
 * narrative paragraph rather than a keyword list, use photographic terms for photorealism, refer to
 * input images by their order ("the first image"), say what to keep in an edit ("change only ...,
 * keep everything else exactly the same"), and phrase exclusions positively (a "plain, unmarked
 * surface" rather than "no logo"). The aspect ratio travels in the request config, not the prompt.
 *
 * Same content rules as the house prompts: identity only from the bible, the product only by its
 * appearance line (its name is removed), no text in the image.
 * @packageDocumentation
 */
import type { BodySpec, FaceSpec, ProductPhotoSpec, RefineSpec, SheetSpec, StillSpec } from "@creator-lab/core/domain/shot-spec";
import { ATHLETICWEAR, BACKDROPS, PHOTO_MATCH, backdropFor, inline, productAppearance, sentence, withoutProductName } from "./prompts";

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth"];

/** "the first image" for reference image 1. */
export function nthImage(position: number): string {
  return `the ${ORDINALS[position - 1] ?? `number ${position}`} image`;
}

const CLEAN = "A clean image without added text, captions, logos, or watermarks.";
const SILHOUETTE = "The outfit stands out clearly against the background so the silhouette reads.";

export function geminiFacePrompt(spec: FaceSpec): string {
  return [
    sentence(spec.visualCore),
    `A photorealistic head-and-shoulders portrait of this person wearing ${inline(spec.garment)}.`,
    "The head is turned about thirty degrees to the left, so the far cheek narrows and the near ear shows, while the eyes look back toward the camera with a neutral expression and a hint of a smile.",
    `Soft natural window light falls across the face, in front of ${BACKDROPS[backdropFor(spec.garment)]}.`,
    "It looks like an 85mm portrait photograph, with natural skin texture, sharp focus on the eyes, and only the accessories described.",
    SILHOUETTE,
    CLEAN,
  ].join(" ");
}

export function geminiBodyPrompt(spec: BodySpec): string {
  return [
    `Using the person in ${nthImage(spec.face)} as the identity reference, create a photorealistic full-body photo of the same person with an identical face and hair.`,
    spec.photographed ? PHOTO_MATCH : "",
    `Build: ${sentence(spec.build)}`,
    `They stand in a relaxed three-quarter pose, body turned about thirty degrees from the camera, arms at their sides, in fitted ${ATHLETICWEAR[spec.backdrop]} athleticwear (a plain fitted tee with leggings or shorts) and simple trainers, the whole body from head to toe inside the frame.`,
    `The background is ${BACKDROPS[spec.backdrop]}, lit with even, soft light.`,
    SILHOUETTE,
    CLEAN,
  ]
    .filter(Boolean)
    .join(" ");
}

export function geminiSheetPrompt(spec: SheetSpec): string {
  return [
    `Create a character reference sheet of one consistent person on ${BACKDROPS[backdropFor(spec.wardrobe)].replace("seamless background", "seamless studio background")}, laid out as three vertical columns read left to right, with the same identity, lighting, and color grading in every panel.`,
    "The first and largest column, about a third of the width, is a chest-up portrait turned slightly off frontal, with sharp focus on the eyes, the iris color clearly visible, soft catchlights, and natural skin texture with subtle imperfections.",
    "The second column is a full-body front view in a relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins.",
    "The third column is a full-body back view in the same pose, showing how the hair falls, the posture, and how the clothes fit.",
    `The person is the one in ${nthImage(spec.face)} (face, hair, skin, and eyes) with the build of the person in ${nthImage(spec.body)}. ${sentence(spec.visualCore)}`,
    `In every panel they wear ${inline(spec.wardrobe)}. ${SILHOUETTE}${spec.photographed ? ` ${PHOTO_MATCH}` : ""}`,
    "Soft, even studio light from a large diffused key with gentle fill, neutral white balance, true-to-life skin, an 85mm look, and tack-sharp detail, like a real photograph rather than a 3D render. The sheet carries no labels, text, or logos.",
  ].join(" ");
}

export function geminiProductPhotoPrompt(spec: ProductPhotoSpec): string {
  const setting = spec.setting ?? "a light wooden kitchen counter by a window";
  return [
    `A clean product photograph of ${productAppearance(spec.product)}, standing upright on ${inline(setting)} in soft morning light against a plain, uncluttered background.`,
    "The product is true to its shape, color, and materials, with a plain, unmarked surface, and it is the only object in the frame.",
    CLEAN,
  ].join(" ");
}

const OPENINGS: Record<StillSpec["beat"]["type"], string> = {
  talking: "A candid vertical phone photo for a UGC video ad, the start frame of a talking moment.",
  broll: "A candid vertical close-up phone photo for a UGC video ad, a detail shot framed on hands and objects.",
  textcard: "A calm, uncluttered vertical phone photo for a UGC video ad, with open, empty space in the upper third where a caption will be added later.",
};

export function geminiStillPrompt(spec: StillSpec): string {
  const { beat, character, product, set } = spec;
  const lines: string[] = [OPENINGS[beat.type]];
  const wearing = spec.wardrobe ? `, wearing ${inline(spec.wardrobe)}` : "";
  if (spec.visualCore && character) {
    if (character.mode === "sheet") {
      lines.push(`The person is the one in ${nthImage(character.image)}, the character reference sheet${wearing}. ${sentence(spec.visualCore)}`);
    } else {
      const body = character.body ? `, with the build of the person in ${nthImage(character.body)}` : "";
      lines.push(`The person is the one in ${nthImage(character.face)}${body}${wearing}. ${sentence(spec.visualCore)}`);
    }
    if (beat.type === "talking") lines.push("They are mid-sentence, talking to a phone camera held at arm's length, with a relaxed, natural expression and lips slightly parted as if speaking.");
  }
  lines.push(sentence(product ? withoutProductName(beat.visual, product) : beat.visual));
  if (set?.image && set.photo) lines.push(`The setting is the place in ${nthImage(set.image)} (${inline(set.name)}), with the same layout, furniture, and light.`);
  else if (set?.image) lines.push(`The setting is the location in ${nthImage(set.image)}, ${inline(set.name)}.`);
  else if (set) lines.push(`The setting is ${inline(set.name)}.`);
  else if (beat.setting) lines.push(`The setting is ${inline(beat.setting)}.`);
  if (product && beat.productVisible) {
    const source = product.image ? ` from ${nthImage(product.image)}` : "";
    lines.push(`The product${source}, ${productAppearance(product)}, is clearly visible and true to its shape, color, and materials, with a plain, unmarked surface.`);
  } else if (product?.image) {
    lines.push(`The product from ${nthImage(product.image)} stays out of this shot.`);
  }
  lines.push("The frame holds only the objects described here, in natural light with real-world textures, like an unedited photo taken on a phone.");
  lines.push("The photo itself fills the whole frame, with no camera app interface or phone border.", CLEAN);
  if (spec.visualCore && character) {
    lines.push(
      character.mode === "sheet"
        ? `Keep the person's face, hair, build, and outfit exactly as in ${nthImage(character.image)}.`
        : `Keep the person's face and hair exactly as in ${nthImage(character.face)}.`,
    );
    if (character.photographed) lines.push(PHOTO_MATCH);
  }
  return lines.join(" ");
}

export function geminiRefinePrompt(spec: RefineSpec): string {
  const keep =
    spec.subject === "sheet"
      ? "the three-panel layout, the same person in every panel, the outfit, and the clean seamless background"
      : "the person, the product, the composition, the lighting, and the background";
  return `Using the provided image, ${inline(spec.instruction)}. Change only that, and keep everything else exactly the same: ${keep}. ${CLEAN}`;
}
