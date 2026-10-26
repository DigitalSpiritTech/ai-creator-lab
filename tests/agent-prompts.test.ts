import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { CREATIVE_DIRECTOR_PROMPT, agentTools, loadSnapshot, nextStage, systemPrompt } from "@/server/agent";
import { AGENT_TOOL_DESCRIPTIONS } from "@/server/agent/tools";
import { stagePrompt } from "@/server/agent/prompts/creative-director";
import { INTERNAL_TOOLS, TOOLS, type ToolContext, callTool, toolsToJsonSchema } from "@/server/tools";
import { PROMPT_LIMIT, facePrompt } from "@/server/tools/prompts";
import { averyBible, clock, seedProject, tempStore } from "./support/domain-fixtures";
import { promptCases } from "./support/prompt-cases";

/** Snapshots of every template for the Avery Lane bible and the Ridgeline script. */
const EXPECTED: Record<string, string> = {
  face:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. Portrait, head and shoulders, head turned about thirty degrees to the left so the far cheek narrows and the near ear shows, eyes toward the camera, neutral expression with a hint of a smile, soft natural window light, plain light gray background, no accessories beyond those described, photographic, 85mm look. No text, captions, logos, or watermarks in the image.",
  body:
    "Same person as the reference image, identical face and hair. Build: Average height, athletic and relaxed. Three-quarter view full-body standing pose, body turned about thirty degrees from the camera, relaxed, arms at sides, fitted neutral athleticwear (plain fitted tee and leggings or shorts), simple trainers, head to toe inside the frame, plain light gray background, even soft light, photographic. No text, captions, logos, or watermarks in the image.",
  sheet:
    "Character reference sheet of one consistent person, on a deep neutral grey (#3a3a3c) seamless studio background, clean editorial layout in three vertical columns read left to right, identical identity, lighting, and color grading in every panel.\nColumn 1, largest, about a third of the width: chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights in both eyes, natural skin texture with subtle imperfections, no mirror symmetry.\nColumn 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins.\nColumn 3: full-body back view, same pose mirrored, showing hair fall, posture, and garment fit.\nThe person is the person in reference image 1 (face, hair, skin, eyes) with the build of reference image 2. Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. Wardrobe in every panel: Olive utility jacket over a white tee.\nSoft even studio light, large diffused key with gentle fill, neutral white balance, true-to-life skin, 85mm look, tack-sharp detail. No text, no labels, no logos, no colored rim light, no 3D render look.",
  stillTalkingSheet:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. The person shown in the character reference sheet, reference image 1, wearing olive utility jacket over a white tee. Mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking. Avery in the driver's seat holding the Ridgeline bottle, morning light. Setting: a car interior. The product in reference image 2 is the Ridgeline 32 oz insulated bottle, clearly visible and recognizable, true to its shape, color, and label. Vertical 9:16 phone photo, natural light, candid UGC look. No text, captions, logos, or watermarks in the image. Preserve the person's identity, face, hair, build, and wardrobe exactly as in the sheet.",
  stillTalkingFaceBody:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. The person in reference image 1 with the build of reference image 2, wearing olive utility jacket over a white tee. Mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking. Avery at a kitchen counter, bottle open, condensation. Setting: a bright kitchen counter by a window. The product in reference image 3 is the Ridgeline 32 oz insulated bottle, clearly visible and recognizable, true to its shape, color, and label. Vertical 9:16 phone photo, natural light, candid UGC look. No text, captions, logos, or watermarks in the image. Preserve the person's identity, face, and hair exactly as in reference image 1.",
  stillBroll:
    "Close detail shot. Hands pulling a warm plastic bottle from a hot car console. Setting: a car interior. The product in reference image 1 is the Ridgeline 32 oz insulated bottle. No faces in frame. Vertical 9:16 phone photo, natural light, candid UGC look. No text, captions, logos, or watermarks in the image.",
  stillTextcardWithSet:
    "Simple uncluttered composition with calm empty space in the upper third for a caption added later. The Ridgeline bottle on the kitchen counter in soft window light. Setting: the location in reference image 2, bright kitchen counter by a window. The product in reference image 1 is the Ridgeline 32 oz insulated bottle, clearly visible and recognizable, true to its shape, color, and label. No faces in frame. Vertical 9:16 phone photo, natural light, candid UGC look. No text, captions, logos, or watermarks in the image.",
  clipTalking:
    "Avery in the driver's seat holding the Ridgeline bottle, morning light, speaking to the camera with an easy smile, small natural head movement, static phone camera. Wearing Olive utility jacket over a white tee. Quiet ambient sound of a car interior. The person says, \"I stopped buying bottled water the day this fit my cup holder.\" No text on screen. The person's face and clothing stay consistent.",
  clipBroll:
    "Hands pulling a warm plastic bottle from a hot car console, one simple motion, slow push-in. Ambient sound of a car interior, no speech, ambient sound only. No faces in frame. No text on screen.",
  clipTextcard:
    "The Ridgeline bottle on the kitchen counter in soft window light, almost still with very subtle natural motion, static camera. Soft ambient sound of a bright kitchen counter by a window, no speech, ambient sound only. No text on screen.",
  refineStill:
    "Make the morning light warmer. Change only that. Keep the person, product, composition, lighting, and background otherwise identical. No text, captions, logos, or watermarks in the image.",
  refineSheet:
    "Clean the grime from the background. Change only that. Keep the three-panel layout, the same person in every panel, the wardrobe, and the clean deep grey background otherwise identical. No text, captions, logos, or watermarks in the image.",
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

  test("stills reference the sheet when approved and face plus body otherwise", () => {
    const cases = promptCases();
    assert.match(cases.stillTalkingSheet, /character reference sheet, reference image 1, wearing olive utility jacket/);
    assert.match(cases.stillTalkingSheet, /The product in reference image 2 is the Ridgeline/);
    assert.match(cases.stillTalkingFaceBody, /reference image 1 with the build of reference image 2/);
    assert.match(cases.stillTalkingFaceBody, /The product in reference image 3/);
    assert.match(cases.stillBroll, /No faces in frame/);
    for (const name of ["stillTalkingSheet", "stillTalkingFaceBody", "stillBroll", "stillTextcardWithSet"]) {
      assert.match(cases[name], /No text, captions, logos, or watermarks/, name);
    }
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
      "13. Next piece",
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
    const registry = toolsToJsonSchema();
    assert.deepEqual(offered.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
    assert.deepEqual(Object.keys(AGENT_TOOL_DESCRIPTIONS).sort(), TOOLS.map((tool) => tool.name).sort());
    for (const [index, tool] of offered.entries()) {
      assert.equal(tool.description, AGENT_TOOL_DESCRIPTIONS[tool.name]);
      assert.match(tool.description!, /Example/, tool.name);
      assert.ok(tool.description!.length < 1000, tool.name);
      assert.deepEqual(tool.input_schema, registry[index].input_schema, tool.name);
    }
  });

  test("internal tools such as submit_proposal are never offered", () => {
    const names = agentTools().map((tool) => tool.name);
    for (const internal of INTERNAL_TOOLS) assert.equal(names.includes(internal.name), false, internal.name);
    assert.equal(names.includes("submit_proposal"), false);
  });
});
