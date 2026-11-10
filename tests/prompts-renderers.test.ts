/**
 * Per-model prompt renderers (v0.2 F3): one shot spec rendered in each model's style. Snapshots of
 * the Gemini (Nano Banana), GPT Image, and MiniMax H3 renderers for the Avery Lane bible and the
 * Ridgeline script, the rules each style follows, the fallback to the house prompts, and how a
 * recipe's style is inferred.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { inferPromptStyle } from "@/lib/catalog";
import { defaultRecipes } from "@/server/catalog/defaults";
import { adapterRecipes } from "@/server/catalog/router-adapters";
import { H3_PROMPT_LIMIT } from "@/server/tools/prompts-minimax-h3";
import { PROMPT_LIMIT, clipPrompt, facePrompt, kreaFacePrompt, stillPrompt } from "@/server/tools/prompts";
import { renderPrompt, rendersNatively } from "@/server/tools/render";
import { RIDGELINE_APPEARANCE } from "./support/domain-fixtures";
import { CLIP_CASES, IMAGE_CASES, IMAGE_STYLES, renderCases, renderSpecs, styleRecipe } from "./support/render-cases";

const workflowsDir = fileURLToPath(new URL("../workflows/", import.meta.url));
const LOOK = { name: "Ridgeline 32 oz insulated bottle", appearance: RIDGELINE_APPEARANCE };

const EXPECTED: Record<string, string> = {
  "gemini-image:face":
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. A photorealistic head-and-shoulders portrait of this person wearing a plain fitted navy crew-neck top. The head is turned about thirty degrees to the left, so the far cheek narrows and the near ear shows, while the eyes look back toward the camera with a neutral expression and a hint of a smile. Soft natural window light falls across the face, in front of a deep neutral gray (#3a3a3c) seamless background. It looks like an 85mm portrait photograph, with natural skin texture, sharp focus on the eyes, and only the accessories described. The outfit stands out clearly against the background so the silhouette reads. A clean image without added text, captions, logos, or watermarks.",
  "gemini-image:body":
    "Using the person in the first image as the identity reference, create a photorealistic full-body photo of the same person with an identical face and hair. Build: Average height, athletic and relaxed. They stand in a relaxed three-quarter pose, body turned about thirty degrees from the camera, arms at their sides, in fitted navy athleticwear (a plain fitted tee with leggings or shorts) and simple trainers, the whole body from head to toe inside the frame. The background is a deep neutral gray (#3a3a3c) seamless background, lit with even, soft light. The outfit stands out clearly against the background so the silhouette reads. A clean image without added text, captions, logos, or watermarks.",
  "gemini-image:bodyFromPhoto":
    "Using the person in the first image as the identity reference, create a photorealistic full-body photo of the same person with an identical face and hair. Match the real person's features exactly as photographed. Build: Average height, athletic and relaxed. They stand in a relaxed three-quarter pose, body turned about thirty degrees from the camera, arms at their sides, in fitted charcoal athleticwear (a plain fitted tee with leggings or shorts) and simple trainers, the whole body from head to toe inside the frame. The background is a light warm neutral seamless background (light greige, roughly #d8d2c8), lit with even, soft light. The outfit stands out clearly against the background so the silhouette reads. A clean image without added text, captions, logos, or watermarks.",
  "gemini-image:sheet":
    "Create a character reference sheet of one consistent person on a deep neutral gray (#3a3a3c) seamless studio background, laid out as three vertical columns read left to right, with the same identity, lighting, and color grading in every panel. The first and largest column, about a third of the width, is a chest-up portrait turned slightly off frontal, with sharp focus on the eyes, the iris color clearly visible, soft catchlights, and natural skin texture with subtle imperfections. The second column is a full-body front view in a relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins. The third column is a full-body back view in the same pose, showing how the hair falls, the posture, and how the clothes fit. The person is the one in the first image (face, hair, skin, and eyes) with the build of the person in the second image. Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. In every panel they wear olive utility jacket over a white tee. The outfit stands out clearly against the background so the silhouette reads. Soft, even studio light from a large diffused key with gentle fill, neutral white balance, true-to-life skin, an 85mm look, and tack-sharp detail, like a real photograph rather than a 3D render. The sheet carries no labels, text, or logos.",
  "gemini-image:sheetDarkWardrobe":
    "Create a character reference sheet of one consistent person on a light warm neutral seamless studio background (light greige, roughly #d8d2c8), laid out as three vertical columns read left to right, with the same identity, lighting, and color grading in every panel. The first and largest column, about a third of the width, is a chest-up portrait turned slightly off frontal, with sharp focus on the eyes, the iris color clearly visible, soft catchlights, and natural skin texture with subtle imperfections. The second column is a full-body front view in a relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins. The third column is a full-body back view in the same pose, showing how the hair falls, the posture, and how the clothes fit. The person is the one in the first image (face, hair, skin, and eyes) with the build of the person in the second image. Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. In every panel they wear heather gray hoodie and black leggings. The outfit stands out clearly against the background so the silhouette reads. Soft, even studio light from a large diffused key with gentle fill, neutral white balance, true-to-life skin, an 85mm look, and tack-sharp detail, like a real photograph rather than a 3D render. The sheet carries no labels, text, or logos.",
  "gemini-image:productPhoto":
    "A clean product photograph of a matte dark green 32 oz insulated steel bottle with a black screw cap, standing upright on a light wooden kitchen counter by a window in soft morning light against a plain, uncluttered background. The product is true to its shape, color, and materials, with a plain, unmarked surface, and it is the only object in the frame. A clean image without added text, captions, logos, or watermarks.",
  "gemini-image:stillTalkingSheet":
    "A candid vertical phone photo for a UGC video ad, the start frame of a talking moment. The person is the one in the first image, the character reference sheet, wearing olive utility jacket over a white tee. Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. They are mid-sentence, talking to a phone camera held at arm's length, with a relaxed, natural expression and lips slightly parted as if speaking. Avery in the driver's seat holding the bottle, morning light. The setting is a car interior. The product from the second image, a matte dark green 32 oz insulated steel bottle with a black screw cap, is clearly visible and true to its shape, color, and materials, with a plain, unmarked surface. The frame holds only the objects described here, in natural light with real-world textures, like an unedited photo taken on a phone. The photo itself fills the whole frame, with no camera app interface or phone border. A clean image without added text, captions, logos, or watermarks. Keep the person's face, hair, build, and outfit exactly as in the first image.",
  "gemini-image:stillTalkingFaceBodySetPhoto":
    "A candid vertical phone photo for a UGC video ad, the start frame of a talking moment. The person is the one in the first image, with the build of the person in the second image, wearing olive utility jacket over a white tee. Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. They are mid-sentence, talking to a phone camera held at arm's length, with a relaxed, natural expression and lips slightly parted as if speaking. Avery at a kitchen counter, bottle open, condensation. The setting is the place in the fourth image (bright kitchen counter by a window), with the same layout, furniture, and light. The product from the third image, a matte dark green 32 oz insulated steel bottle with a black screw cap, is clearly visible and true to its shape, color, and materials, with a plain, unmarked surface. The frame holds only the objects described here, in natural light with real-world textures, like an unedited photo taken on a phone. The photo itself fills the whole frame, with no camera app interface or phone border. A clean image without added text, captions, logos, or watermarks. Keep the person's face and hair exactly as in the first image. Match the real person's features exactly as photographed.",
  "gemini-image:stillBrollNoProduct":
    "A candid vertical close-up phone photo for a UGC video ad, a detail shot framed on hands and objects. Hands pulling a warm plastic bottle from a hot car console. The setting is a car interior. The product from the first image stays out of this shot. The frame holds only the objects described here, in natural light with real-world textures, like an unedited photo taken on a phone. The photo itself fills the whole frame, with no camera app interface or phone border. A clean image without added text, captions, logos, or watermarks.",
  "gemini-image:stillBrollProduct":
    "A candid vertical close-up phone photo for a UGC video ad, a detail shot framed on hands and objects. The bottle going into a dishwasher rack. The setting is a bright kitchen counter by a window. The product from the first image, a matte dark green 32 oz insulated steel bottle with a black screw cap, is clearly visible and true to its shape, color, and materials, with a plain, unmarked surface. The frame holds only the objects described here, in natural light with real-world textures, like an unedited photo taken on a phone. The photo itself fills the whole frame, with no camera app interface or phone border. A clean image without added text, captions, logos, or watermarks.",
  "gemini-image:stillTextcardSet":
    "A calm, uncluttered vertical phone photo for a UGC video ad, with open, empty space in the upper third where a caption will be added later. The bottle on the kitchen counter in soft window light. The setting is the location in the second image, bright kitchen counter by a window. The product from the first image, a matte dark green 32 oz insulated steel bottle with a black screw cap, is clearly visible and true to its shape, color, and materials, with a plain, unmarked surface. The frame holds only the objects described here, in natural light with real-world textures, like an unedited photo taken on a phone. The photo itself fills the whole frame, with no camera app interface or phone border. A clean image without added text, captions, logos, or watermarks.",
  "gemini-image:refineStill":
    "Using the provided image, make the morning light warmer. Change only that, and keep everything else exactly the same: the person, the product, the composition, the lighting, and the background. A clean image without added text, captions, logos, or watermarks.",
  "gemini-image:refineSheet":
    "Using the provided image, clean the grime from the background. Change only that, and keep everything else exactly the same: the three-panel layout, the same person in every panel, the outfit, and the clean seamless background. A clean image without added text, captions, logos, or watermarks.",
  "gpt-image:face":
    "Intended use: a face reference that locks a character's identity for a series of UGC ad photos.\nSubject: Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings.\nFraming: photorealistic head-and-shoulders portrait, wearing a plain fitted navy crew-neck top; head turned about thirty degrees to the left so the far cheek narrows and the near ear shows; eyes toward the camera; neutral expression with a hint of a smile.\nLight and background: soft natural window light; a deep neutral gray (#3a3a3c) seamless background.\nStyle: an 85mm portrait photograph with natural skin texture and sharp focus on the eyes.\nConstraints: no accessories beyond those described; the outfit contrasts clearly with the background so the silhouette reads; no text, captions, logos, or watermarks.",
  "gpt-image:body":
    "Intended use: a full-body character reference for a series of UGC ad photos.\nReference images:\n- Image 1: the person's face, the identity reference\nSubject: the same person as Image 1, with an identical face and hair. Build: Average height, athletic and relaxed.\nPose: three-quarter view, full body standing, turned about thirty degrees from the camera, relaxed, arms at sides, head to toe inside the frame.\nWardrobe: fitted navy athleticwear (plain fitted tee and leggings or shorts) and simple trainers.\nLight and background: even soft light; a deep neutral gray (#3a3a3c) seamless background.\nStyle: photorealistic photograph.\nConstraints: keep the face and hair exactly as in Image 1; the outfit contrasts clearly with the background so the silhouette reads; no text, captions, logos, or watermarks.",
  "gpt-image:bodyFromPhoto":
    "Intended use: a full-body character reference for a series of UGC ad photos.\nReference images:\n- Image 1: the person's face, the identity reference\nSubject: the same person as Image 1, with an identical face and hair. Match the real person's features exactly as photographed. Build: Average height, athletic and relaxed.\nPose: three-quarter view, full body standing, turned about thirty degrees from the camera, relaxed, arms at sides, head to toe inside the frame.\nWardrobe: fitted charcoal athleticwear (plain fitted tee and leggings or shorts) and simple trainers.\nLight and background: even soft light; a light warm neutral seamless background (light greige, roughly #d8d2c8).\nStyle: photorealistic photograph.\nConstraints: keep the face and hair exactly as in Image 1; the outfit contrasts clearly with the background so the silhouette reads; no text, captions, logos, or watermarks.",
  "gpt-image:sheet":
    "Intended use: a character reference sheet that every photo of this person in the project is made from.\nReference images:\n- Image 1: the person's face (face, hair, skin, eyes)\n- Image 2: the person's full body (build)\nSubject: Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. The same person in every panel, wearing olive utility jacket over a white tee.\nLayout: three vertical columns read left to right. Column 1, largest, about a third of the width: a chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights, natural skin texture. Column 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe with even margins. Column 3: full-body back view in the same pose, showing hair fall, posture, and garment fit.\nLight and background: soft even studio light with a large diffused key and gentle fill, neutral white balance; a deep neutral gray (#3a3a3c) seamless studio background.\nStyle: photorealistic, true-to-life skin, an 85mm look, tack-sharp detail.\nConstraints: identical identity, lighting, and color grading in every panel; the outfit contrasts clearly with the background so the silhouette reads; no labels; no text, captions, logos, or watermarks; no colored rim light; no 3D render look.",
  "gpt-image:sheetDarkWardrobe":
    "Intended use: a character reference sheet that every photo of this person in the project is made from.\nReference images:\n- Image 1: the person's face (face, hair, skin, eyes)\n- Image 2: the person's full body (build)\nSubject: Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. The same person in every panel, wearing heather gray hoodie and black leggings.\nLayout: three vertical columns read left to right. Column 1, largest, about a third of the width: a chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights, natural skin texture. Column 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe with even margins. Column 3: full-body back view in the same pose, showing hair fall, posture, and garment fit.\nLight and background: soft even studio light with a large diffused key and gentle fill, neutral white balance; a light warm neutral seamless studio background (light greige, roughly #d8d2c8).\nStyle: photorealistic, true-to-life skin, an 85mm look, tack-sharp detail.\nConstraints: identical identity, lighting, and color grading in every panel; the outfit contrasts clearly with the background so the silhouette reads; no labels; no text, captions, logos, or watermarks; no colored rim light; no 3D render look.",
  "gpt-image:productPhoto":
    "Intended use: a product photo for a product card in a UGC ad project.\nScene: a light wooden kitchen counter by a window, soft morning light, a plain uncluttered background.\nSubject: a matte dark green 32 oz insulated steel bottle with a black screw cap, standing upright, true to its shape, color, and materials.\nStyle: photorealistic product photograph with real-world textures.\nConstraints: only the product, with no other bottles, phones, or props; no text, lettering, or logo on the product; no text, captions, logos, or watermarks.",
  "gpt-image:stillTalkingSheet":
    "Intended use: the start frame of one beat in a vertical 9:16 UGC video ad, a candid phone photo rather than a studio shot.\nReference images:\n- Image 1: character reference sheet of the person (face, hair, build, outfit)\n- Image 2: product photo; reproduce this exact product\nScene: a car interior.\nSubject: Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. This is the person in Image 1, wearing olive utility jacket over a white tee; mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking.\nAction: Avery in the driver's seat holding the bottle, morning light.\nProduct: a matte dark green 32 oz insulated steel bottle with a black screw cap, the product from Image 2, clearly visible, true to its shape, color, and materials.\nStyle: photorealistic phone photo, natural light, real-world textures, candid UGC look, the photo itself filling the frame.\nConstraints: keep the person's face, hair, build, and outfit exactly as in Image 1; only the objects described; no additional phones or props, and no bottles beyond those described; no text, lettering, or logo on the product; no text, captions, logos, or watermarks; no camera app interface, buttons, icons, or phone frame.",
  "gpt-image:stillTalkingFaceBodySetPhoto":
    "Intended use: the start frame of one beat in a vertical 9:16 UGC video ad, a candid phone photo rather than a studio shot.\nReference images:\n- Image 1: the person's face (identity)\n- Image 2: the person's full body (build)\n- Image 3: product photo; reproduce this exact product\n- Image 4: photo of the real place (bright kitchen counter by a window); match its layout, furniture, and lighting\nScene: the place in Image 4.\nSubject: Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. This is the person in Image 1 with the build of Image 2, wearing olive utility jacket over a white tee; mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking.\nAction: Avery at a kitchen counter, bottle open, condensation.\nProduct: a matte dark green 32 oz insulated steel bottle with a black screw cap, the product from Image 3, clearly visible, true to its shape, color, and materials.\nStyle: photorealistic phone photo, natural light, real-world textures, candid UGC look, the photo itself filling the frame.\nConstraints: keep the person's face and hair exactly as in Image 1, matching the real person exactly as photographed; only the objects described; no additional phones or props, and no bottles beyond those described; no text, lettering, or logo on the product; no text, captions, logos, or watermarks; no camera app interface, buttons, icons, or phone frame.",
  "gpt-image:stillBrollNoProduct":
    "Intended use: the start frame of one beat in a vertical 9:16 UGC video ad, a candid phone photo rather than a studio shot.\nReference images:\n- Image 1: product photo, for reference only; the product is not in this shot\nScene: a car interior.\nAction: a close detail shot. Hands pulling a warm plastic bottle from a hot car console.\nStyle: photorealistic phone photo, natural light, real-world textures, candid UGC look, the photo itself filling the frame.\nConstraints: only the objects described; no additional phones or props, and no bottles beyond those described; no faces in frame; no text, lettering, or logo on the product; no text, captions, logos, or watermarks; no camera app interface, buttons, icons, or phone frame.",
  "gpt-image:stillBrollProduct":
    "Intended use: the start frame of one beat in a vertical 9:16 UGC video ad, a candid phone photo rather than a studio shot.\nReference images:\n- Image 1: product photo; reproduce this exact product\nScene: a bright kitchen counter by a window.\nAction: a close detail shot. The bottle going into a dishwasher rack.\nProduct: a matte dark green 32 oz insulated steel bottle with a black screw cap, the product from Image 1, clearly visible, true to its shape, color, and materials.\nStyle: photorealistic phone photo, natural light, real-world textures, candid UGC look, the photo itself filling the frame.\nConstraints: only the objects described; no additional phones or props, and no bottles beyond those described; no faces in frame; no text, lettering, or logo on the product; no text, captions, logos, or watermarks; no camera app interface, buttons, icons, or phone frame.",
  "gpt-image:stillTextcardSet":
    "Intended use: the start frame of one beat in a vertical 9:16 UGC video ad, a candid phone photo rather than a studio shot.\nReference images:\n- Image 1: product photo; reproduce this exact product\n- Image 2: the location, bright kitchen counter by a window\nScene: the place in Image 2.\nAction: a simple, uncluttered composition with calm empty space in the upper third for a caption added later. The bottle on the kitchen counter in soft window light.\nProduct: a matte dark green 32 oz insulated steel bottle with a black screw cap, the product from Image 1, clearly visible, true to its shape, color, and materials.\nStyle: photorealistic phone photo, natural light, real-world textures, candid UGC look, the photo itself filling the frame.\nConstraints: only the objects described; no additional phones or props, and no bottles beyond those described; no faces in frame; no text, lettering, or logo on the product; no text, captions, logos, or watermarks; no camera app interface, buttons, icons, or phone frame.",
  "gpt-image:refineStill":
    "Edit Image 1: Make the morning light warmer.\nChange only this.\nKeep everything else the same: the person, the product, the composition, the lighting, and the background.\nConstraints: no text, captions, logos, or watermarks.",
  "gpt-image:refineSheet":
    "Edit Image 1: Clean the grime from the background.\nChange only this.\nKeep everything else the same: the three-panel layout, the same person in every panel, the outfit, and the clean seamless background.\nConstraints: no text, captions, logos, or watermarks.",
  "minimax-h3:clipTalking":
    "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Live-action, candid vertical phone-video UGC style, a medium close-up begins from <Picture 1>, showing Avery in the driver's seat holding the bottle, morning light. Avery shown in <Picture 1> keeps the face, hair, clothing, and position exactly as in <Picture 1>. The setting and light stay exactly as in <Picture 1>. Avery looks into the phone camera and talks with an easy smile and small natural head movement. The product shown in <Picture 1> keeps its shape and proportions, facing the camera. The camera shakes slightly like a handheld phone with small amplitude. Avery (S1), speaking in a natural voice, unhurried with natural pauses, says: <d>[English] I stopped buying bottled water the day this fit my cup holder.</d> Avery finishes the line and goes quiet with lips closed.\n\noverall_soundscape: Quiet ambient sound of a car interior.\n\nnon_diegetic_music: N/A",
  "minimax-h3:clipBroll":
    "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Live-action, candid vertical phone-video UGC style, a close-up begins from <Picture 1>, showing hands pulling a warm plastic bottle from a hot car console. The setting and light stay exactly as in <Picture 1>. The action shown in <Picture 1> continues in one simple, smooth motion. The camera pushes in with small amplitude at slow speed.\n\noverall_soundscape: Quiet ambient sound of a car interior.\n\nnon_diegetic_music: N/A",
  "minimax-h3:clipFirstLast":
    "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 5.17-second mark of the target video.\n\nintegrated_multimodal_description: [Shot 1] Live-action, candid vertical phone-video UGC style, a close-up begins from <Picture 1>, showing the bottle going into a dishwasher rack. The setting and light stay exactly as in <Picture 1>. The action shown in <Picture 1> continues in one simple, smooth motion. The product shown in <Picture 1> keeps its shape and proportions, facing the camera. The camera pushes in with small amplitude at slow speed. The motion settles into the pose, framing, and composition established by Picture 2 at the end of the shot, showing the same shot a few seconds later.\n\noverall_soundscape: Quiet ambient sound of a bright kitchen counter by a window.\n\nnon_diegetic_music: N/A",
};

describe("prompt renderers", () => {
  test("match their snapshots", () => {
    const cases = renderCases();
    assert.deepEqual(Object.keys(cases), Object.keys(EXPECTED));
    for (const [name, prompt] of Object.entries(cases)) assert.equal(prompt, EXPECTED[name], name);
  });

  test("stay within each style's limit", () => {
    for (const [name, prompt] of Object.entries(renderCases())) {
      const limit = name.startsWith("minimax-h3:") ? H3_PROMPT_LIMIT : PROMPT_LIMIT;
      assert.ok(prompt.length < limit, `${name} is ${prompt.length} characters`);
    }
  });

  test("never print the product's name, and describe a shown product by the card's appearance line", () => {
    for (const [name, prompt] of Object.entries(renderCases())) {
      assert.doesNotMatch(prompt, /Ridgeline/, name);
      if (/:(stillTalking|stillBrollProduct|stillTextcard|productPhoto)/.test(name)) assert.ok(prompt.includes(RIDGELINE_APPEARANCE), name);
    }
  });

  test("Gemini prompts are one narrative paragraph that names references by order and phrases exclusions positively", () => {
    const cases = renderCases();
    for (const name of IMAGE_CASES) {
      const prompt = cases[`gemini-image:${name}`];
      assert.doesNotMatch(prompt, /\n/, `${name} is one paragraph`);
      assert.doesNotMatch(prompt, /reference image \d|Image \d/, `${name} refers to images by order`);
      assert.doesNotMatch(prompt, /no text, lettering, or logo on the product/, `${name} says the surface is plain instead`);
    }
    assert.match(cases["gemini-image:stillTalkingFaceBodySetPhoto"], /the place in the fourth image/);
    assert.match(cases["gemini-image:stillBrollProduct"], /The product from the first image, a matte dark green/);
    assert.match(cases["gemini-image:refineStill"], /^Using the provided image, make the morning light warmer\. Change only that/);
  });

  test("GPT Image prompts are labeled sections with images by index and an explicit constraints line", () => {
    const cases = renderCases();
    for (const name of IMAGE_CASES) {
      const prompt = cases[`gpt-image:${name}`];
      assert.ok(prompt.split("\n").length >= 3, `${name} has sections`);
      if (!name.startsWith("refine")) assert.match(prompt, /^Intended use: /, name);
      assert.match(prompt, /^Constraints: .*no text, captions, logos, or watermarks/m, name);
    }
    assert.match(cases["gpt-image:stillTalkingFaceBodySetPhoto"], /^- Image 4: photo of the real place/m);
    assert.match(cases["gpt-image:stillBrollProduct"], /^- Image 1: product photo; reproduce this exact product$/m);
    assert.match(cases["gpt-image:refineSheet"], /^Edit Image 1: .*\nChange only this\./);
  });

  test("H3 clip prompts anchor to <Picture 1>, put the line in <d> tags, and carry no quotes or appearance words", () => {
    const cases = renderCases();
    for (const name of CLIP_CASES) {
      const prompt = cases[`minimax-h3:${name}`];
      assert.match(prompt, /integrated_multimodal_description: \[Shot 1\]/, name);
      assert.match(prompt, /non_diegetic_music: N\/A$/, name);
      assert.doesNotMatch(prompt, /["“”]/, name);
      assert.doesNotMatch(prompt, /freckles|hazel|olive utility jacket|matte dark green/, `${name} restates nothing the first frame shows`);
    }
    assert.match(cases["minimax-h3:clipTalking"], /says: <d>\[English\] I stopped buying bottled water the day this fit my cup holder\.<\/d>/);
    assert.match(cases["minimax-h3:clipFirstLast"], /^How the reference pictures align with the target video — Picture 1/);
  });

  test("a style without its own renderer for a kind uses the house prompt", () => {
    const specs = renderSpecs();
    const talking = specs.clipTalking;
    assert.ok(talking.kind === "clip");
    const clip = renderPrompt(talking, styleRecipe("gemini-image", "image_to_video"));
    assert.ok(clip.ok);
    assert.equal(clip.style, "standard");
    assert.equal(clip.prompt, clipPrompt(talking.beat, { product: LOOK }));
    assert.equal(rendersNatively("gemini-image", "clip"), false);
    assert.equal(rendersNatively("minimax-h3", "clip"), true);
    const face = specs.face;
    assert.ok(face.kind === "face");
    const krea = renderPrompt(face, styleRecipe("krea", "text_to_image"));
    assert.ok(krea.ok && krea.prompt === kreaFacePrompt(face));
    const zImage = renderPrompt(face, { id: "z-image-turbo-t2i", kind: "workflow", capability: "text_to_image" });
    assert.ok(zImage.ok && zImage.prompt === facePrompt(face));
    const broll = specs.stillBrollProduct;
    assert.ok(broll.kind === "still");
    const qwen = renderPrompt(broll, { id: "qwen-image-edit-2511-1ref", kind: "workflow", capability: "image_edit" });
    assert.ok(qwen.ok && qwen.prompt === stillPrompt({ beat: broll.beat, wardrobe: null, product: broll.product }));
  });

  test("a spec the model cannot take comes back as a readable error, never a throw", () => {
    const talking = renderSpecs().clipTalking;
    assert.ok(talking.kind === "clip");
    const tooFast = renderPrompt({ ...talking, durationSeconds: 2 }, styleRecipe("minimax-h3", "image_to_video"));
    assert.equal(tooFast.ok, false);
    assert.match(!tooFast.ok ? tooFast.error : "", /MiniMax H3 cannot render beat 1: .*words per second/);
    const speech = renderPrompt({ ...talking, mode: "speech" }, styleRecipe("minimax-h3", "speech_to_video"));
    assert.equal(speech.ok, false);
  });
});

describe("prompt style inference", () => {
  test("real recipes map to their model's style", async () => {
    const recipes = [...(await defaultRecipes(workflowsDir, { mocks: true })), ...adapterRecipes(["openai/gpt-image-2", "vertexai/gemini-3-pro-image", "minimax/minimax-hailuo-02"])];
    const style = (id: string) => inferPromptStyle(recipes.find((recipe) => recipe.id === id) ?? assert.fail(`no recipe ${id}`));
    assert.equal(style("qwen-image-edit-2511-1ref"), "standard");
    assert.equal(style("z-image-turbo-t2i"), "standard");
    assert.equal(style("krea-2-turbo-t2i"), "krea");
    assert.equal(style("router-nano-banana-pro-edit"), "gemini-image");
    assert.equal(style("router-nano-banana-2.1-edit"), "gemini-image");
    assert.equal(style("router-nano-banana-pro-t2i"), "gemini-image");
    assert.equal(style("router-openai-gpt-image-2-text-to-image"), "gpt-image");
    assert.equal(style("router-vertexai-gemini-3-pro-image-image-edit"), "gemini-image");
    assert.equal(style("minimax-h3-i2v"), "minimax-h3");
    assert.equal(style("minimax-h3-flf2v"), "minimax-h3");
    assert.equal(style("minimax-h3-t2i"), "standard", "the H3 still model reads the house prompt");
    assert.equal(style("router-minimax-minimax-hailuo-02-image-to-video"), "standard", "Hailuo is not H3 grammar");
    assert.equal(style("ltx-2.5-i2v"), "standard");
    assert.equal(style("router-kling-3-omni-i2v"), "standard");
    assert.equal(style("mock-image-edit"), "standard");
  });

  test("a recipe's own promptStyle wins over inference", () => {
    assert.equal(inferPromptStyle({ id: "my-workflow", kind: "workflow", capability: "image_edit", promptStyle: "gpt-image" }), "gpt-image");
    for (const style of IMAGE_STYLES) assert.equal(inferPromptStyle(styleRecipe(style)), style);
  });
});
