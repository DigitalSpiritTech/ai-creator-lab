/**
 * Image prompts for OpenAI's GPT Image family (through Comfy Router), rendered from a shot spec.
 * OpenAI's prompting guidance for GPT Image: state the intended use, write in labeled segments
 * (scene, subject, details, constraints) rather than one run-on line, reference each input image by
 * index with what it is ("Image 1: ..."), say exactly what an edit changes and repeat what must stay
 * the same, and put hard exclusions in an explicit constraints line, which the model follows. For a
 * candid look, ask for a real phone photo rather than studio or cinematic polish.
 *
 * Same content rules as the house prompts: identity only from the bible, the product only by its
 * appearance line (its name is removed), no text in the image.
 * @packageDocumentation
 */
import type { BodySpec, FaceSpec, ProductPhotoSpec, RefineSpec, SheetSpec, StillSpec } from "@/lib/domain/shot-spec";
import {
  ATHLETICWEAR,
  BACKDROPS,
  NO_PRODUCT_TEXT,
  PHOTO_MATCH,
  backdropFor,
  clause,
  inline,
  onlyDescribedObjects,
  productAppearance,
  sentence,
  withoutProductName,
} from "@/server/tools/prompts";

const NO_TEXT = "no text, captions, logos, or watermarks";
const CONTRAST = "the outfit contrasts clearly with the background so the silhouette reads";

function lines(...entries: (string | false | undefined)[]): string {
  return entries.filter((entry): entry is string => !!entry).join("\n");
}

function images(entries: [number, string][]): string | undefined {
  if (!entries.length) return undefined;
  return ["Reference images:", ...entries.sort((a, b) => a[0] - b[0]).map(([index, what]) => `- Image ${index}: ${what}`)].join("\n");
}

export function gptFacePrompt(spec: FaceSpec): string {
  return lines(
    "Intended use: a face reference that locks a character's identity for a series of UGC ad photos.",
    `Subject: ${sentence(spec.visualCore)}`,
    `Framing: photorealistic head-and-shoulders portrait, wearing ${inline(spec.garment)}; head turned about thirty degrees to the left so the far cheek narrows and the near ear shows; eyes toward the camera; neutral expression with a hint of a smile.`,
    `Light and background: soft natural window light; ${BACKDROPS[backdropFor(spec.garment)]}.`,
    "Style: an 85mm portrait photograph with natural skin texture and sharp focus on the eyes.",
    `Constraints: no accessories beyond those described; ${CONTRAST}; ${NO_TEXT}.`,
  );
}

export function gptBodyPrompt(spec: BodySpec): string {
  return lines(
    "Intended use: a full-body character reference for a series of UGC ad photos.",
    images([[spec.face, "the person's face, the identity reference"]]),
    `Subject: the same person as Image ${spec.face}, with an identical face and hair. ${spec.photographed ? `${PHOTO_MATCH} ` : ""}Build: ${sentence(spec.build)}`,
    "Pose: three-quarter view, full body standing, turned about thirty degrees from the camera, relaxed, arms at sides, head to toe inside the frame.",
    `Wardrobe: fitted ${ATHLETICWEAR[spec.backdrop]} athleticwear (plain fitted tee and leggings or shorts) and simple trainers.`,
    `Light and background: even soft light; ${BACKDROPS[spec.backdrop]}.`,
    "Style: photorealistic photograph.",
    `Constraints: keep the face and hair exactly as in Image ${spec.face}; ${CONTRAST}; ${NO_TEXT}.`,
  );
}

export function gptSheetPrompt(spec: SheetSpec): string {
  return lines(
    "Intended use: a character reference sheet that every photo of this person in the project is made from.",
    images([
      [spec.face, "the person's face (face, hair, skin, eyes)"],
      [spec.body, "the person's full body (build)"],
    ]),
    `Subject: ${sentence(spec.visualCore)} The same person in every panel, wearing ${inline(spec.wardrobe)}.${spec.photographed ? ` ${PHOTO_MATCH}` : ""}`,
    "Layout: three vertical columns read left to right. Column 1, largest, about a third of the width: a chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights, natural skin texture. Column 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe with even margins. Column 3: full-body back view in the same pose, showing hair fall, posture, and garment fit.",
    `Light and background: soft even studio light with a large diffused key and gentle fill, neutral white balance; ${BACKDROPS[backdropFor(spec.wardrobe)].replace("seamless background", "seamless studio background")}.`,
    "Style: photorealistic, true-to-life skin, an 85mm look, tack-sharp detail.",
    `Constraints: identical identity, lighting, and color grading in every panel; ${CONTRAST}; no labels; ${NO_TEXT}; no colored rim light; no 3D render look.`,
  );
}

export function gptProductPhotoPrompt(spec: ProductPhotoSpec): string {
  const setting = spec.setting ?? "a light wooden kitchen counter by a window";
  return lines(
    "Intended use: a product photo for a product card in a UGC ad project.",
    `Scene: ${inline(setting)}, soft morning light, a plain uncluttered background.`,
    `Subject: ${productAppearance(spec.product)}, standing upright, true to its shape, color, and materials.`,
    "Style: photorealistic product photograph with real-world textures.",
    `Constraints: only the product, with no other bottles, phones, or props; ${NO_PRODUCT_TEXT}; ${NO_TEXT}.`,
  );
}

const ACTIONS: Record<StillSpec["beat"]["type"], string> = {
  talking: "mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking",
  broll: "a close detail shot",
  textcard: "a simple, uncluttered composition with calm empty space in the upper third for a caption added later",
};

export function gptStillPrompt(spec: StillSpec): string {
  const { beat, character, product, set } = spec;
  const refs: [number, string][] = [];
  const inFrame = !!(spec.visualCore && character);
  if (inFrame && character) {
    if (character.mode === "sheet") refs.push([character.image, "character reference sheet of the person (face, hair, build, outfit)"]);
    else {
      refs.push([character.face, "the person's face (identity)"]);
      if (character.body) refs.push([character.body, "the person's full body (build)"]);
    }
  }
  if (product?.image) refs.push([product.image, beat.productVisible ? "product photo; reproduce this exact product" : "product photo, for reference only; the product is not in this shot"]);
  if (set?.image) refs.push([set.image, set.photo ? `photo of the real place (${inline(set.name)}); match its layout, furniture, and lighting` : `the location, ${inline(set.name)}`]);

  const visual = product ? withoutProductName(beat.visual, product) : beat.visual;
  const scene = set?.image ? `the place in Image ${set.image}` : set ? clause(set.name) : beat.setting ? clause(beat.setting) : undefined;
  let subject: string | undefined;
  if (inFrame && character) {
    const who = character.mode === "sheet" ? `the person in Image ${character.image}` : `the person in Image ${character.face}${character.body ? ` with the build of Image ${character.body}` : ""}`;
    subject = `Subject: ${sentence(spec.visualCore!)} This is ${who}${spec.wardrobe ? `, wearing ${inline(spec.wardrobe)}` : ""}; ${ACTIONS[beat.type]}.`;
  }
  const keep = inFrame && character
    ? character.mode === "sheet"
      ? `keep the person's face, hair, build, and outfit exactly as in Image ${character.image}${character.photographed ? ", matching the real person exactly as photographed" : ""}; `
      : `keep the person's face and hair exactly as in Image ${character.face}${character.photographed ? ", matching the real person exactly as photographed" : ""}; `
    : "";
  return lines(
    "Intended use: the start frame of one beat in a vertical 9:16 UGC video ad, a candid phone photo rather than a studio shot.",
    images(refs),
    scene ? `Scene: ${scene}.` : undefined,
    subject,
    `Action: ${inFrame ? "" : `${ACTIONS[beat.type]}. `}${sentence(visual)}`,
    product && beat.productVisible ? `Product: ${productAppearance(product)}${product.image ? `, the product from Image ${product.image}` : ""}, clearly visible, true to its shape, color, and materials.` : undefined,
    "Style: photorealistic phone photo, natural light, real-world textures, candid UGC look, the photo itself filling the frame.",
    `Constraints: ${keep}${inline(onlyDescribedObjects(visual))}${inFrame || beat.type === "talking" ? "" : "; no faces in frame"}; ${NO_PRODUCT_TEXT}; ${NO_TEXT}; no camera app interface, buttons, icons, or phone frame.`,
  );
}

export function gptRefinePrompt(spec: RefineSpec): string {
  const keep =
    spec.subject === "sheet"
      ? "the three-panel layout, the same person in every panel, the outfit, and the clean seamless background"
      : "the person, the product, the composition, the lighting, and the background";
  return lines(`Edit Image 1: ${sentence(spec.instruction)}`, "Change only this.", `Keep everything else the same: ${keep}.`, `Constraints: ${NO_TEXT}.`);
}
