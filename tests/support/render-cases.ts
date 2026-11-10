/**
 * Shot specs for the Avery Lane bible and the Ridgeline script, rendered in every prompt style, for
 * the snapshot tests in prompts-renderers.test.ts.
 * @packageDocumentation
 */
import type { PromptStyle } from "@creator-lab/core/catalog";
import { type ShotSpec, type ShotSpecInput, ShotSpecSchema } from "@creator-lab/core/domain/shot-spec";
import { FACE_GARMENT } from "@creator-lab/recipes/prompts";
import { renderPrompt } from "@creator-lab/recipes/render";
import { RIDGELINE_APPEARANCE } from "./domain-fixtures";
import { DARK_WARDROBE, PRODUCT, WARDROBE, fixtureBeats, fixtureBible } from "./prompt-cases";

const LOOK = { name: PRODUCT, appearance: RIDGELINE_APPEARANCE };

/** One spec per kind and branch; the acceptance's product still is `stillBrollProduct`. */
export function renderSpecs(): Record<string, ShotSpec> {
  const bible = fixtureBible();
  const [hook, problem, proof, dishwasher, cta] = fixtureBeats();
  const specs: Record<string, ShotSpecInput> = {
    face: { kind: "face", visualCore: bible.visualCore, garment: FACE_GARMENT },
    body: { kind: "body", build: bible.build, backdrop: "gray" },
    bodyFromPhoto: { kind: "body", build: bible.build, backdrop: "light", photographed: true },
    sheet: { kind: "sheet", visualCore: bible.visualCore, wardrobe: WARDROBE },
    sheetDarkWardrobe: { kind: "sheet", visualCore: bible.visualCore, wardrobe: DARK_WARDROBE },
    productPhoto: { kind: "product_photo", product: LOOK },
    stillTalkingSheet: { kind: "still", beat: hook, visualCore: bible.visualCore, wardrobe: WARDROBE, character: { mode: "sheet", image: 1 }, product: { ...LOOK, image: 2 } },
    stillTalkingFaceBodySetPhoto: {
      kind: "still",
      beat: proof,
      visualCore: bible.visualCore,
      wardrobe: WARDROBE,
      character: { mode: "face", face: 1, body: 2, photographed: true },
      product: { ...LOOK, image: 3 },
      set: { name: "Bright kitchen counter by a window", image: 4, photo: true },
    },
    stillBrollNoProduct: { kind: "still", beat: problem, product: { ...LOOK, image: 1 } },
    stillBrollProduct: { kind: "still", beat: dishwasher, product: { ...LOOK, image: 1 } },
    stillTextcardSet: { kind: "still", beat: cta, product: { ...LOOK, image: 1 }, set: { name: "Bright kitchen counter by a window", image: 2 } },
    refineStill: { kind: "refine", instruction: "Make the morning light warmer." },
    refineSheet: { kind: "refine", instruction: "Clean the grime from the background", subject: "sheet" },
    clipTalking: {
      kind: "clip",
      beat: hook,
      durationSeconds: 5,
      character: { name: bible.name, visualCore: bible.visualCore, wardrobe: WARDROBE, voice: "a natural voice, unhurried with natural pauses" },
      product: LOOK,
    },
    clipBroll: { kind: "clip", beat: problem, durationSeconds: 5, product: LOOK },
    clipFirstLast: { kind: "clip", beat: dishwasher, mode: "first_last", durationSeconds: 5, product: LOOK },
  };
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, ShotSpecSchema.parse(spec)]));
}

/** Which styles render which cases natively; each is snapshotted. */
export const IMAGE_STYLES: PromptStyle[] = ["gemini-image", "gpt-image"];
export const IMAGE_CASES = ["face", "body", "bodyFromPhoto", "sheet", "sheetDarkWardrobe", "productPhoto", "stillTalkingSheet", "stillTalkingFaceBodySetPhoto", "stillBrollNoProduct", "stillBrollProduct", "stillTextcardSet", "refineStill", "refineSheet"];
export const CLIP_CASES = ["clipTalking", "clipBroll", "clipFirstLast"];

/** A stand-in recipe for a style, so the dispatcher picks the renderer under test. */
export function styleRecipe(style: PromptStyle, capability = "image_edit") {
  return { id: `test-${style}`, kind: "mock" as const, capability, promptStyle: style };
}

export function renderCases(): Record<string, string> {
  const specs = renderSpecs();
  const out: Record<string, string> = {};
  for (const style of IMAGE_STYLES) {
    for (const name of IMAGE_CASES) {
      const rendered = renderPrompt(specs[name], styleRecipe(style));
      out[`${style}:${name}`] = rendered.ok ? rendered.prompt : `ERROR ${rendered.error}`;
    }
  }
  for (const name of CLIP_CASES) {
    const rendered = renderPrompt(specs[name], styleRecipe("minimax-h3", "image_to_video"));
    out[`minimax-h3:${name}`] = rendered.ok ? rendered.prompt : `ERROR ${rendered.error}`;
  }
  return out;
}
