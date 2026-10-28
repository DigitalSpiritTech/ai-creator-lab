import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { CREATIVE_DIRECTOR_PROMPT, agentTools, loadSnapshot, nextStage, systemPrompt } from "@/server/agent";
import { AGENT_TOOL_DESCRIPTIONS } from "@/server/agent/tools";
import { stagePrompt } from "@/server/agent/prompts/creative-director";
import { AGENT_TOOLS, INTERNAL_TOOLS, TOOLS, type ToolContext, callTool, toolsToJsonSchema } from "@/server/tools";
import { PROMPT_LIMIT, backdropFor, backdropOf, facePrompt, onlyDescribedObjects, withoutProductName } from "@/server/tools/prompts";
import { averyBible, clock, seedProject, tempStore } from "./support/domain-fixtures";
import { promptCases } from "./support/prompt-cases";

/** Snapshots of every template for the Avery Lane bible and the Ridgeline script. */
const EXPECTED: Record<string, string> = {
  face:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. Portrait, head and shoulders, wearing a plain fitted navy crew-neck top, head turned about thirty degrees to the left so the far cheek narrows and the near ear shows, eyes toward the camera, neutral expression with a hint of a smile, soft natural window light, a deep neutral gray (#3a3a3c) seamless background, no accessories beyond those described, photographic, 85mm look. The outfit must contrast clearly with the background so the silhouette reads. No text, captions, logos, or watermarks in the image.",
  faceDarkGarment:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. Portrait, head and shoulders, wearing a heather gray hoodie, head turned about thirty degrees to the left so the far cheek narrows and the near ear shows, eyes toward the camera, neutral expression with a hint of a smile, soft natural window light, a light warm neutral seamless background (light greige, roughly #d8d2c8), no accessories beyond those described, photographic, 85mm look. The outfit must contrast clearly with the background so the silhouette reads. No text, captions, logos, or watermarks in the image.",
  body:
    "Same person as the reference image, identical face and hair. Build: Average height, athletic and relaxed. Three-quarter view full-body standing pose, body turned about thirty degrees from the camera, relaxed, arms at sides, fitted navy athleticwear (plain fitted tee and leggings or shorts), simple trainers, head to toe inside the frame, a deep neutral gray (#3a3a3c) seamless background, even soft light, photographic. The outfit must contrast clearly with the background so the silhouette reads. No text, captions, logos, or watermarks in the image.",
  bodyLightBackdrop:
    "Same person as the reference image, identical face and hair. Build: Average height, athletic and relaxed. Three-quarter view full-body standing pose, body turned about thirty degrees from the camera, relaxed, arms at sides, fitted charcoal athleticwear (plain fitted tee and leggings or shorts), simple trainers, head to toe inside the frame, a light warm neutral seamless background (light greige, roughly #d8d2c8), even soft light, photographic. The outfit must contrast clearly with the background so the silhouette reads. No text, captions, logos, or watermarks in the image.",
  sheet:
    "Character reference sheet of one consistent person, on a deep neutral gray (#3a3a3c) seamless studio background, clean editorial layout in three vertical columns read left to right, identical identity, lighting, and color grading in every panel.\nColumn 1, largest, about a third of the width: chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights in both eyes, natural skin texture with subtle imperfections, no mirror symmetry.\nColumn 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins.\nColumn 3: full-body back view, same pose mirrored, showing hair fall, posture, and garment fit.\nThe person is the person in reference image 1 (face, hair, skin, eyes) with the build of reference image 2. Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. Wardrobe in every panel: Olive utility jacket over a white tee. The outfit must contrast clearly with the background so the silhouette reads.\nSoft even studio light, large diffused key with gentle fill, neutral white balance, true-to-life skin, 85mm look, tack-sharp detail. No text, no labels, no logos, no colored rim light, no 3D render look.",
  sheetDarkWardrobe:
    "Character reference sheet of one consistent person, on a light warm neutral seamless studio background (light greige, roughly #d8d2c8), clean editorial layout in three vertical columns read left to right, identical identity, lighting, and color grading in every panel.\nColumn 1, largest, about a third of the width: chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights in both eyes, natural skin texture with subtle imperfections, no mirror symmetry.\nColumn 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins.\nColumn 3: full-body back view, same pose mirrored, showing hair fall, posture, and garment fit.\nThe person is the person in reference image 1 (face, hair, skin, eyes) with the build of reference image 2. Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. Wardrobe in every panel: Heather gray hoodie and black leggings. The outfit must contrast clearly with the background so the silhouette reads.\nSoft even studio light, large diffused key with gentle fill, neutral white balance, true-to-life skin, 85mm look, tack-sharp detail. No text, no labels, no logos, no colored rim light, no 3D render look.",
  stillTalkingSheet:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. The person shown in the character reference sheet, reference image 1, wearing olive utility jacket over a white tee. Mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking. Avery in the driver's seat holding the bottle, morning light. Setting: a car interior. The product in reference image 2 is a 32 oz insulated bottle, clearly visible, true to its shape, color, and materials, no text, lettering, or logo on the product. Only the objects described; no additional phones or props, and no bottles beyond those described. Vertical 9:16 phone photo, natural light, candid UGC look. The photo itself, full frame, not a screenshot: no camera app interface, buttons, icons, or phone frame. No text, captions, logos, or watermarks in the image. Preserve the person's identity, face, hair, build, and wardrobe exactly as in the sheet.",
  stillTalkingFaceBody:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. The person in reference image 1 with the build of reference image 2, wearing olive utility jacket over a white tee. Mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking. Avery at a kitchen counter, bottle open, condensation. Setting: a bright kitchen counter by a window. The product in reference image 3 is a 32 oz insulated bottle, clearly visible, true to its shape, color, and materials, no text, lettering, or logo on the product. Only the objects described; no additional phones or props, and no bottles beyond those described. Vertical 9:16 phone photo, natural light, candid UGC look. The photo itself, full frame, not a screenshot: no camera app interface, buttons, icons, or phone frame. No text, captions, logos, or watermarks in the image. Preserve the person's identity, face, and hair exactly as in reference image 1.",
  stillPhotographedWithSetPhoto:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. The person in reference image 1, wearing olive utility jacket over a white tee. Mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking. Avery at the head of the boardroom table, bottle open beside her. Setting: the place in reference image 3 (our boardroom), matching its layout, furniture, and lighting. The product in reference image 2 is a 32 oz insulated bottle, clearly visible, true to its shape, color, and materials, no text, lettering, or logo on the product. Only the objects described; no additional phones or props, and no bottles beyond those described. Vertical 9:16 phone photo, natural light, candid UGC look. The photo itself, full frame, not a screenshot: no camera app interface, buttons, icons, or phone frame. No text, captions, logos, or watermarks in the image. Preserve the person's identity, face, and hair exactly as in reference image 1. Match the real person's features exactly as photographed.",
  stillSheetPhotographed:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. The person shown in the character reference sheet, reference image 1, wearing olive utility jacket over a white tee. Mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking. Avery in the driver's seat holding the bottle, morning light. Setting: a car interior. The product in reference image 2 is a 32 oz insulated bottle, clearly visible, true to its shape, color, and materials, no text, lettering, or logo on the product. Only the objects described; no additional phones or props, and no bottles beyond those described. Vertical 9:16 phone photo, natural light, candid UGC look. The photo itself, full frame, not a screenshot: no camera app interface, buttons, icons, or phone frame. No text, captions, logos, or watermarks in the image. Preserve the person's identity, face, hair, build, and wardrobe exactly as in the sheet. Match the real person's features exactly as photographed.",
  bodyFromPhoto:
    "Same person as the reference image, identical face and hair. Match the real person's features exactly as photographed. Build: Average height, athletic and relaxed. Three-quarter view full-body standing pose, body turned about thirty degrees from the camera, relaxed, arms at sides, fitted navy athleticwear (plain fitted tee and leggings or shorts), simple trainers, head to toe inside the frame, a deep neutral gray (#3a3a3c) seamless background, even soft light, photographic. The outfit must contrast clearly with the background so the silhouette reads. No text, captions, logos, or watermarks in the image.",
  sheetFromPhoto:
    "Character reference sheet of one consistent person, on a deep neutral gray (#3a3a3c) seamless studio background, clean editorial layout in three vertical columns read left to right, identical identity, lighting, and color grading in every panel.\nColumn 1, largest, about a third of the width: chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights in both eyes, natural skin texture with subtle imperfections, no mirror symmetry.\nColumn 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins.\nColumn 3: full-body back view, same pose mirrored, showing hair fall, posture, and garment fit.\nThe person is the person in reference image 1 (face, hair, skin, eyes) with the build of reference image 2. Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. Wardrobe in every panel: Olive utility jacket over a white tee. The outfit must contrast clearly with the background so the silhouette reads. Match the real person's features exactly as photographed.\nSoft even studio light, large diffused key with gentle fill, neutral white balance, true-to-life skin, 85mm look, tack-sharp detail. No text, no labels, no logos, no colored rim light, no 3D render look.",
  stillBroll:
    "Close detail shot. Hands pulling a warm plastic bottle from a hot car console. Setting: a car interior. The product in reference image 1 stays out of this shot. Only the objects described; no additional phones or props, and no bottles beyond those described. No faces in frame. Vertical 9:16 phone photo, natural light, candid UGC look. The photo itself, full frame, not a screenshot: no camera app interface, buttons, icons, or phone frame. No text, captions, logos, or watermarks in the image.",
  stillTextcardWithSet:
    "Simple uncluttered composition with calm empty space in the upper third for a caption added later. The bottle on the kitchen counter in soft window light. Setting: the location in reference image 2, bright kitchen counter by a window. The product in reference image 1 is a 32 oz insulated bottle, clearly visible, true to its shape, color, and materials, no text, lettering, or logo on the product. Only the objects described; no additional phones or props, and no bottles beyond those described. No faces in frame. Vertical 9:16 phone photo, natural light, candid UGC look. The photo itself, full frame, not a screenshot: no camera app interface, buttons, icons, or phone frame. No text, captions, logos, or watermarks in the image.",
  clipTalking:
    "Avery in the driver's seat holding the bottle, morning light, speaking to the camera with an easy smile, small natural head movement, static phone camera. Wearing Olive utility jacket over a white tee. The product is a 32 oz insulated bottle, no text, lettering, or logo on the product. Quiet ambient sound of a car interior. The person says, \"I stopped buying bottled water the day this fit my cup holder.\" No text on screen. The person's face and clothing stay consistent.",
  clipBroll:
    "Hands pulling a warm plastic bottle from a hot car console, one simple motion, slow push-in. Ambient sound of a car interior, no speech, ambient sound only. No faces in frame. No text on screen.",
  clipTextcard:
    "The bottle on the kitchen counter in soft window light, almost still with very subtle natural motion, static camera. The product is a 32 oz insulated bottle, no text, lettering, or logo on the product. Soft ambient sound of a bright kitchen counter by a window, no speech, ambient sound only. No text on screen.",
  productPhoto:
    "Product photograph of a matte dark green steel bottle with a black screw cap, standing upright on a light wooden kitchen counter by a window, soft morning light, plain uncluttered background, true to its shape, color, and materials, no text, lettering, or logo on the product. Only the product; no additional bottles, phones, or props. No text, captions, logos, or watermarks in the image.",
  refineStill:
    "Make the morning light warmer. Change only that. Keep the person, product, composition, lighting, and background otherwise identical. No text, captions, logos, or watermarks in the image.",
  refineSheet:
    "Clean the grime from the background. Change only that. Keep the three-panel layout, the same person in every panel, the wardrobe, and the clean seamless background otherwise identical. No text, captions, logos, or watermarks in the image.",
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("prompt templates", () => {
  test("match their snapshots", () => {
    const cases = promptCases();
    assert.deepEqual(Object.keys(cases), Object.keys(EXPECTED));
    for (const [name, prompt] of Object.entries(cases)) assert.equal(prompt, EXPECTED[name], name);
  });

  test("stay under the recipe prompt limit", () => {
    assert.equal(PROMPT_LIMIT, 2000);
    for (const [name, prompt] of Object.entries(promptCases())) assert.ok(prompt.length < PROMPT_LIMIT, `${name} is ${prompt.length} characters`);
  });

  test("face lock spells out the thirty-degree turn and never relies on 'three-quarter view' alone", () => {
    const { face, body } = promptCases();
    assert.match(face, /head turned about thirty degrees/);
    assert.doesNotMatch(face, /three-quarter view/i);
    assert.ok(face.startsWith(averyBible().visualCore));
    assert.match(body, /thirty degrees/);
    assert.match(body, /athleticwear/);
  });

  test("reference backgrounds contrast with the outfit: deep gray by default, light warm for gray or dark clothing", () => {
    const cases = promptCases();
    for (const name of ["face", "body", "sheet"]) {
      assert.match(cases[name], /deep neutral gray \(#3a3a3c\) seamless/, name);
      assert.equal(backdropOf(cases[name]), "gray", name);
    }
    for (const name of ["faceDarkGarment", "bodyLightBackdrop", "sheetDarkWardrobe"]) {
      assert.match(cases[name], /light warm neutral seamless (studio )?background \(light greige, roughly #d8d2c8\)/, name);
      assert.equal(backdropOf(cases[name]), "light", name);
    }
    for (const name of ["face", "faceDarkGarment", "body", "bodyLightBackdrop", "sheet", "sheetDarkWardrobe"]) {
      assert.match(cases[name], /The outfit must contrast clearly with the background so the silhouette reads\./, name);
      assert.doesNotMatch(cases[name], /(white|black) (seamless |studio )*background/i, name);
    }
    assert.match(cases.body, /fitted navy athleticwear/);
    assert.match(cases.bodyLightBackdrop, /fitted charcoal athleticwear/);
    assert.doesNotMatch(cases.body, /neutral athleticwear/);
    for (const garment of ["gray tee", "Grey hoodie", "charcoal jacket", "black leggings", "dark denim"]) assert.equal(backdropFor(garment), "light", garment);
    for (const garment of ["Olive utility jacket over a white tee", "Oatmeal knit sweater and jeans", "navy athleticwear"]) assert.equal(backdropFor(garment), "gray", garment);
  });

  test("uploaded photos keep the identity wording, add the real-person match, and anchor a photographed place", () => {
    const cases = promptCases();
    const match = "Match the real person's features exactly as photographed.";
    assert.match(cases.stillPhotographedWithSetPhoto, /The person in reference image 1, wearing olive utility jacket/);
    assert.match(cases.stillPhotographedWithSetPhoto, /Preserve the person's identity, face, and hair exactly as in reference image 1\. Match the real person's features exactly as photographed\.$/);
    assert.match(cases.stillPhotographedWithSetPhoto, /Setting: the place in reference image 3 \(our boardroom\), matching its layout, furniture, and lighting\./);
    assert.match(cases.stillSheetPhotographed, /character reference sheet, reference image 1[\s\S]*exactly as in the sheet\. Match the real person's/);
    for (const name of ["bodyFromPhoto", "sheetFromPhoto"]) assert.ok(cases[name].includes(match), name);
    for (const name of ["stillTalkingSheet", "stillTalkingFaceBody", "body", "sheet"]) assert.equal(cases[name].includes(match), false, `${name} is generated, not photographed`);
    assert.match(cases.stillTextcardWithSet, /Setting: the location in reference image 2, bright kitchen counter/, "a set image not marked as a photo keeps the location wording");
  });

  test("stills reference the sheet when approved and face plus body otherwise", () => {
    const cases = promptCases();
    assert.match(cases.stillTalkingSheet, /character reference sheet, reference image 1, wearing olive utility jacket/);
    assert.match(cases.stillTalkingSheet, /The product in reference image 2 is a 32 oz insulated bottle/);
    assert.match(cases.stillTalkingFaceBody, /reference image 1 with the build of reference image 2/);
    assert.match(cases.stillTalkingFaceBody, /The product in reference image 3/);
    assert.match(cases.stillBroll, /No faces in frame/);
    for (const name of ["stillTalkingSheet", "stillTalkingFaceBody", "stillBroll", "stillTextcardWithSet"]) {
      assert.match(cases[name], /No text, captions, logos, or watermarks/, name);
    }
  });

  test("image and video prompts describe the product by look, never by name, and forbid text on it", () => {
    const cases = promptCases();
    for (const [name, prompt] of Object.entries(cases)) assert.doesNotMatch(prompt, /Ridgeline/, name);
    for (const name of ["stillTalkingSheet", "stillTalkingFaceBody", "stillTextcardWithSet", "clipTalking", "clipTextcard", "productPhoto"]) {
      assert.match(cases[name], /(is|of) (a|an) [^.]*, no text, lettering, or logo on the product\./, name);
    }
    assert.match(cases.stillBroll, /The product in reference image 1 stays out of this shot\./, "a beat without the product does not invite it in");
    assert.match(cases.productPhoto, /^Product photograph of a matte dark green steel bottle with a black screw cap,/);
    assert.equal(withoutProductName("Avery holding the Ridgeline bottle", { name: "Ridgeline 32 oz insulated bottle" }), "Avery holding the bottle");
    assert.equal(withoutProductName("Hands on the Ridgeline 32 oz insulated bottle.", { name: "Ridgeline 32 oz insulated bottle" }), "Hands on the 32 oz insulated bottle.");
    assert.equal(withoutProductName("A bottle by the window", { name: "Bottle" }), "A product by the window", "a name with no generic part is replaced only as a whole word");
  });

  test("stills allow only the described objects without contradicting the beat", () => {
    const cases = promptCases();
    for (const name of ["stillTalkingSheet", "stillTalkingFaceBody", "stillBroll", "stillTextcardWithSet"]) assert.match(cases[name], /Only the objects described;/, name);
    assert.equal(onlyDescribedObjects("Avery at a desk, laptop open."), "Only the objects described; no additional bottles, phones, or props.");
    assert.equal(onlyDescribedObjects("Hands lifting the bottle from the cup holder."), "Only the objects described; no additional phones or props, and no bottles beyond those described.");
    assert.equal(onlyDescribedObjects("A phone and a bottle on the dashboard, a few props."), "Only the objects described; no bottles, phones, or props beyond those described.");
  });

  test("clips quote the spoken line on talking beats, keep b-roll ambient, and always forbid text", () => {
    const cases = promptCases();
    assert.match(cases.clipTalking, /The person says, "I stopped buying bottled water the day this fit my cup holder\."/);
    assert.match(cases.clipBroll, /no speech, ambient sound only/);
    assert.match(cases.clipTextcard, /no speech, ambient sound only/);
    for (const name of ["clipTalking", "clipBroll", "clipTextcard"]) assert.match(cases[name], /No text on screen\./, name);
  });
});

describe("creative director prompt", () => {
  test("carries the role, the flow, and every rule", () => {
    for (const phrase of [
      "creative director",
      "never generate anything",
      "Never say an image, sheet, clip, or ad was generated",
      "Never invent or change identity details",
      "Product claims come only from the product card",
      "safe for work",
      "at most one consequential question",
      "offer a default",
      "user's own words",
      "Keep replies short",
      "Never refuse because a step is out of order",
      "what to look for",
      "12. Voice-overs",
      "14. Next piece",
    ]) {
      assert.ok(CREATIVE_DIRECTOR_PROMPT.includes(phrase), phrase);
    }
    assert.ok(CREATIVE_DIRECTOR_PROMPT.length < 12_000, `${CREATIVE_DIRECTOR_PROMPT.length} characters`);
  });

  test("stage guidance follows project state and hands the model the exact face prompt", async () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    const tools: ToolContext = { store, now, newId: randomUUID };

    assert.equal(nextStage(loadSnapshot(store, project.id)!).id, "brief");
    assert.deepEqual(systemPrompt(), [{ text: CREATIVE_DIRECTOR_PROMPT, cache: true }], "the system prompt holds no project state");
    const state = stagePrompt(loadSnapshot(store, project.id)!);
    assert.ok(state.startsWith("<project_state>") && state.endsWith("</project_state>"));
    assert.match(state, /Next step: 3\. Brief/);
    assert.match(state, new RegExp(`projectId ${project.id}`));

    await callTool(tools, "save_brief", {
      projectId: project.id,
      brief: { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters", platforms: ["TikTok"], tone: "Warm, direct" },
    });
    assert.equal(nextStage(loadSnapshot(store, project.id)!).id, "character");
    const saved = await callTool(tools, "save_character_bible", { projectId: project.id, bible: averyBible() });
    assert.ok(saved.ok);
    const stage = nextStage(loadSnapshot(store, project.id)!);
    assert.equal(stage.id, "face");
    assert.ok(stage.guidance.includes(facePrompt(averyBible())));
    assert.match(stagePrompt(loadSnapshot(store, project.id)!, { omittedTurns: 3 }), /3 older turn\(s\) are not shown/);
  });
});

describe("tool descriptions", () => {
  test("every roster tool has a model-facing description with an example, and schemas are unchanged", () => {
    const offered = agentTools();
    const registry = new Map(toolsToJsonSchema().map((tool) => [tool.name, tool]));
    assert.deepEqual(offered.map((tool) => tool.name), AGENT_TOOLS.map((tool) => tool.name));
    assert.deepEqual(Object.keys(AGENT_TOOL_DESCRIPTIONS).sort(), TOOLS.map((tool) => tool.name).sort());
    for (const tool of offered) {
      assert.equal(tool.description, AGENT_TOOL_DESCRIPTIONS[tool.name]);
      assert.match(tool.description!, /Example/, tool.name);
      assert.ok(tool.description!.length < 1000, tool.name);
      assert.deepEqual(tool.input_schema, registry.get(tool.name)!.input_schema, tool.name);
    }
  });

  test("internal tools such as submit_proposal, and permanent deletion, are never offered to the assistant", () => {
    const names = agentTools().map((tool) => tool.name);
    for (const internal of INTERNAL_TOOLS) assert.equal(names.includes(internal.name), false, internal.name);
    assert.equal(names.includes("submit_proposal"), false);
    assert.equal(names.includes("delete_asset_everywhere"), false);
    assert.ok(TOOLS.some((tool) => tool.name === "delete_asset_everywhere"), "the UI and MCP still have it");
  });
});
