/**
 * Every prompt template applied to the Avery Lane bible and the Ridgeline script, for the
 * snapshot tests in agent-prompts.test.ts.
 * @packageDocumentation
 */
import { type CharacterBible, CharacterBibleSchema } from "@/lib/domain/library";
import { type Beat, BeatSchema } from "@/lib/domain/script";
import { bodyPrompt, clipPrompt, facePrompt, productPhotoPrompt, referenceSheetPrompt, refinePrompt, stillPrompt } from "@/server/tools/prompts";
import { averyBible, ridgelineBeats } from "./domain-fixtures";

export const WARDROBE = "Olive utility jacket over a white tee";
export const PRODUCT = "Ridgeline 32 oz insulated bottle";
/** A wardrobe that needs the light background (gray and black clothing). */
export const DARK_WARDROBE = "Heather gray hoodie and black leggings";

export function fixtureBible(): CharacterBible {
  return CharacterBibleSchema.parse({ ...averyBible(), references: { faceAssetId: null, bodyAssetId: null }, version: 1 });
}

export function fixtureBeats(): Beat[] {
  const beats = ridgelineBeats().map((beat, position) => BeatSchema.parse({ ...beat, index: position + 1 }));
  const textcard = BeatSchema.parse({
    index: beats.length + 1,
    type: "textcard",
    purpose: "cta",
    onScreenText: "Link in bio.",
    visual: "The Ridgeline bottle on the kitchen counter in soft window light.",
    setting: "a bright kitchen counter by a window",
    productVisible: true,
  });
  return [...beats, textcard];
}

export function promptCases(): Record<string, string> {
  const bible = fixtureBible();
  const [hook, problem, proof, , cta] = fixtureBeats();
  return {
    face: facePrompt(bible),
    faceDarkGarment: facePrompt(bible, "a heather gray hoodie"),
    body: bodyPrompt(bible),
    bodyLightBackdrop: bodyPrompt(bible, "light"),
    sheet: referenceSheetPrompt(bible, WARDROBE),
    sheetDarkWardrobe: referenceSheetPrompt(bible, DARK_WARDROBE),
    stillTalkingSheet: stillPrompt({ beat: hook, bible, wardrobe: WARDROBE, character: { mode: "sheet", image: 1 }, product: { name: PRODUCT, image: 2 } }),
    stillTalkingFaceBody: stillPrompt({ beat: proof, bible, wardrobe: WARDROBE, character: { mode: "face", face: 1, body: 2 }, product: { name: PRODUCT, image: 3 } }),
    stillPhotographedWithSetPhoto: stillPrompt({
      beat: { ...proof, visual: "Avery at the head of the boardroom table, bottle open beside her.", setting: "Our boardroom" },
      bible,
      wardrobe: WARDROBE,
      character: { mode: "face", face: 1, photographed: true },
      product: { name: PRODUCT, image: 2 },
      set: { name: "Our boardroom", image: 3, photo: true },
    }),
    stillSheetPhotographed: stillPrompt({ beat: hook, bible, wardrobe: WARDROBE, character: { mode: "sheet", image: 1, photographed: true }, product: { name: PRODUCT, image: 2 } }),
    bodyFromPhoto: bodyPrompt(bible, "gray", { photographed: true }),
    sheetFromPhoto: referenceSheetPrompt(bible, WARDROBE, { photographed: true }),
    stillBroll: stillPrompt({ beat: problem, product: { name: PRODUCT, image: 1 } }),
    stillTextcardWithSet: stillPrompt({ beat: cta, product: { name: PRODUCT, image: 1 }, set: { name: "Bright kitchen counter by a window", image: 2 } }),
    clipTalking: clipPrompt(hook, { wardrobe: WARDROBE, product: { name: PRODUCT } }),
    clipBroll: clipPrompt(problem, { product: { name: PRODUCT } }),
    clipTextcard: clipPrompt(cta, { product: { name: PRODUCT } }),
    productPhoto: productPhotoPrompt({ name: PRODUCT, appearance: "a matte dark green steel bottle with a black screw cap" }),
    refineStill: refinePrompt("Make the morning light warmer."),
    refineSheet: refinePrompt("Clean the grime from the background", "sheet"),
  };
}
