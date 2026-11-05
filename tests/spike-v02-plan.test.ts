/**
 * The v0.2 spike's dry-run plan, built offline: every step resolves a recipe from the starter
 * catalog, the slots apply to the graphs, H3 lengths follow 17n+5 and LTX 8n+1, the multi-frame
 * keyframes sit inside the clip, and the ceilings fit the 420-credit cap.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { kreaFacePrompt } from "@/server/tools/prompts";
import { CHAIN_LINES, DIALOGUE_LINE, I2VA_ALIGNMENT, PERSON_WITH_TRAITS, cutTime, h3ChainPrompts, h3DialoguePrompt, h3MultiframePrompt } from "../scripts/spike/h3-prompts";
import { DEFAULT_CAP_CREDITS, DERIVED_IMAGE, STEP_IDS, buildSpikePlan, followsRule, formatPlan, frameIndex, legacyLtxDialoguePrompt, parseSteps, spikeInputsFromEnv } from "../scripts/spike/v02-plan";
import { averyBible } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../workflows/", import.meta.url));

describe("v0.2 spike plan", () => {
  test("the dry-run plan resolves every step, validates every graph, and fits the cap", async () => {
    const plan = await buildSpikePlan({ steps: parseSteps(undefined), inputs: spikeInputsFromEnv({}), workflowsDir });
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.steps.map((step) => step.id), [...STEP_IDS]);
    assert.equal(plan.capCredits, DEFAULT_CAP_CREDITS);
    assert.ok(plan.totalCredits <= DEFAULT_CAP_CREDITS, `${plan.totalCredits} credits`);
    const runs = Object.fromEntries(plan.steps.map((step) => [step.id, step.runs]));

    assert.equal(runs.krea.length, 3);
    for (const run of runs.krea) {
      assert.equal(run.recipeId, "krea-2-turbo-t2i");
      assert.equal(run.via, "generate_face_candidates");
      assert.equal(run.prompt, kreaFacePrompt(averyBible()));
      assert.deepEqual([run.width, run.height], [1024, 1024]);
    }
    const [h3] = runs["h3-dialogue"];
    const [ltx] = runs["ltx-dialogue"];
    assert.deepEqual([h3.recipeId, h3.width, h3.height, h3.frames], ["minimax-h3-i2v", 736, 1312, 124]);
    assert.deepEqual([ltx.recipeId, ltx.width, ltx.height, ltx.frames], ["ltx-2.5-i2v", 576, 1024, 121]);
    assert.deepEqual(h3.images, ltx.images, "both dialogue steps start from the same still");
    assert.ok(h3.prompt.includes(DIALOGUE_LINE) && ltx.prompt.includes(DIALOGUE_LINE), "and say the same line");
    assert.ok(followsRule(h3.frames!, "17n+5") && followsRule(ltx.frames!, "8n+1"));
    assert.ok(ltx.prompt.startsWith("Use the provided start image as the first frame. "));

    // A/B steps: each differs from its baseline in exactly one thing, on the same still and seed.
    const [traits] = runs["h3-traits"];
    assert.equal(traits.prompt, h3DialoguePrompt(DIALOGUE_LINE, PERSON_WITH_TRAITS));
    assert.match(traits.prompt, /light freckles/);
    assert.doesNotMatch(h3.prompt, /freckles|hazel|hoop/, "the baseline points at <Picture 1> instead");
    assert.deepEqual([traits.recipeId, traits.images, traits.seed], [h3.recipeId, h3.images, h3.seed]);
    const variants = runs["ltx-variants"];
    assert.deepEqual(variants.map((run) => run.slots), [
      { imageStrength: 0.85, imgCompression: 0 },
      { imageStrength: 0.7, imgCompression: 0 },
      { imageStrength: 0.85, imgCompression: 18 },
    ]);
    assert.equal(variants[0].prompt, legacyLtxDialoguePrompt(DIALOGUE_LINE));
    assert.ok(variants.slice(1).every((run) => run.prompt === ltx.prompt), "the settings runs keep the new prompt");
    for (const run of [...variants, ...runs["h3-chain"], ...runs["h3-multiframe"]]) assert.equal(run.seed, 42, run.label);
    assert.equal(spikeInputsFromEnv({ SPIKE_SEED: "7" }).seed, 7);

    const [multi] = runs["h3-multiframe"];
    assert.equal(multi.recipeId, "minimax-h3-multiframe");
    assert.equal(multi.capability, "references_to_video");
    assert.equal(multi.images.length, 3);
    assert.equal(multi.frames, 192, "8 s snaps to 192 frames on the 17n+5 grid");
    assert.deepEqual(multi.slots, { image2Frame: 84, image3Frame: 144 });

    const chain = runs["h3-chain"];
    assert.deepEqual(chain.map((run) => run.images[0]), ["composite.png", DERIVED_IMAGE], "segment 2 starts from segment 1's last frame");
    assert.equal(runs["h3-max-router"].length, 0, "the Router step only reads unless an adapter exists");
    assert.equal(plan.steps.find((step) => step.id === "h3-max-router")!.ceilingCredits, 0);

    const text = formatPlan(plan);
    assert.match(text, /total ceiling: [\d.]+ USD \([\d.]+ credits\) of the 420-credit cap/);
    assert.match(text, /plan valid/);
  });

  test("steps are selectable and unknown names are refused", async () => {
    assert.deepEqual(parseSteps(" krea , h3-chain,krea"), ["krea", "h3-chain"]);
    assert.throws(() => parseSteps("krea,h4"), /Unknown spike step h4/);
    const plan = await buildSpikePlan({ steps: ["ltx-dialogue"], inputs: spikeInputsFromEnv({}), workflowsDir });
    assert.deepEqual(plan.steps.map((step) => step.id), ["ltx-dialogue"]);
    assert.equal(plan.totalCredits, 16.8);
  });

  test("bad timings, lengths and caps show up as plan problems instead of reaching a paid run", async () => {
    const late = await buildSpikePlan({ steps: ["h3-multiframe"], inputs: spikeInputsFromEnv({ KEYFRAME_SECONDS: "3,9" }), workflowsDir });
    assert.match(late.problems.join(" "), /image3Frame 216 is outside the 192-frame clip/);
    const tight = await buildSpikePlan({ steps: ["h3-chain"], inputs: spikeInputsFromEnv({}), workflowsDir, capCredits: 50 });
    assert.match(tight.problems.join(" "), /exceed the 50-credit cap/);
    const inputs = spikeInputsFromEnv({ STILL: "mine.png", KEYFRAMES: "a.png,b.png", KEYFRAME_NOTES: "one|two", MULTIFRAME_SECONDS: "6" });
    assert.deepEqual([inputs.still, inputs.keyframes, inputs.keyframeNotes, inputs.multiframeSeconds], ["mine.png", ["a.png", "b.png"], ["one", "two"], 6]);
    assert.equal(frameIndex(1.5), 36, "the template's round(seconds x 24)");
    assert.ok(followsRule(124, "17n+5") && !followsRule(120, "17n+5") && followsRule(121, "8n+1"));
  });
});

describe("H3 spike prompts", () => {
  test("image to video opens with the I2VA alignment line and speaks with a speaker id", () => {
    const prompt = h3DialoguePrompt();
    assert.ok(prompt.startsWith(`${I2VA_ALIGNMENT}\n\nintegrated_multimodal_description: [Shot 1] `));
    assert.match(prompt, /\(S1\) says: <d>\[English\] Twenty-four hours later it was still cold\. I checked\.<\/d>/);
    assert.match(prompt, /\n\noverall_soundscape: .+\n\nnon_diegetic_music: N\/A$/);
    assert.doesNotMatch(prompt, /Ridgeline/, "the product appears by its look only");
    const [first, second] = h3ChainPrompts();
    assert.ok(first.includes(CHAIN_LINES[0]) && second.includes(CHAIN_LINES[1]));
    assert.match(second, /continuing the same moment/);
  });

  test("the multi-frame prompt maps each picture to a shot and cuts at the keyframe times", () => {
    const prompt = h3MultiframePrompt([3.5, 6]);
    for (const section of ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]) assert.ok(prompt.includes(`${section}\n`), section);
    assert.match(prompt, /<Picture 1> is the first frame of \[Shot 1\]/);
    assert.match(prompt, /<Picture 2> is the keyframe of \[Shot 2\]/);
    assert.match(prompt, /<Picture 3> is the keyframe of \[Shot 3\]/);
    assert.match(prompt, /\[Shot 2\] At 00:03\.500, the shot cuts to/);
    assert.match(prompt, /\[Shot 3\] At 00:06\.000, the shot cuts to/);
    assert.equal(cutTime(75.25), "01:15.250");
  });
});
