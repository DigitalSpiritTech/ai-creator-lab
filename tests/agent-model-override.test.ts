/**
 * Offline eval for model override (v0.2 F3) in the chat: "use Nano Banana for product shots from
 * now on" sets the project preference through set_recipe_preference, the next still uses it with a
 * Gemini-style prompt and no recipeId, and "try that one with GPT Image" regenerates the rejected
 * candidate from the same spec. Scripted model, real loop, real tools, mock executor; scripted token
 * usage is reported per stage.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import sharp from "sharp";
import { MockRecipeSchema, type Recipe } from "@creator-lab/core/catalog";
import { say, scriptedModel, toolUse } from "@/server/agent";
import { importImage } from "@/server/media/images";
import { callTool } from "@/server/tools";
import { type Harness, type TurnResult, agentHarness, approveProposal, latestState, resultJson, runTurn, stateValue } from "./support/agent-harness";
import { ridgelineBeats, ridgelineProduct } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function standIn(id: string, title: string, promptStyle: "gemini-image" | "gpt-image"): Recipe {
  return MockRecipeSchema.parse({ id, kind: "mock", title, capability: "image_edit", openWeights: false, verified: null, costHint: "Test stand-in.", limits: { maxReferences: 14 }, promptStyle });
}
const NANO = standIn("test-nano-banana-pro-edit", "Nano Banana Pro (test stand-in)", "gemini-image");
const GPT = standIn("test-gpt-image-2-edit", "GPT Image 2 edit (test stand-in)", "gpt-image");

async function seed(harness: Harness, name: string, input: unknown) {
  const result = await callTool(harness.tools, name, input);
  if (!result.ok) throw new Error(`${name}: ${result.failure.message}`);
  return result.output as Record<string, unknown>;
}

function clean(turn: TurnResult): TurnResult {
  assert.equal(turn.error, undefined, turn.error ?? "");
  assert.ok(turn.done, "the turn finished");
  return turn;
}

test("eval: a chat phrase sets the project's recipe preference, the next still follows it, and a rejected one is retried with another model", async (t) => {
  const harness = agentHarness();
  cleanups.push(harness.cleanup);
  const { project, tools, store } = harness;
  const base = await tools.generation!.recipes();
  tools.generation!.recipes = async () => [...base, NANO, GPT];
  const usage = (stage: string, turn: TurnResult) =>
    t.diagnostic(`${stage}: ${turn.done!.usage.inputTokens} input, ${turn.done!.usage.outputTokens} output tokens (scripted estimate)`);

  await seed(harness, "save_brief", { projectId: project.id, brief: { productSummary: "the Ridgeline 32 oz insulated bottle", audience: "commuters", platforms: ["TikTok"], tone: "warm" } });
  const bytes = await sharp({ create: { width: 64, height: 96, channels: 3, background: "#2f4a3a" } }).png().toBuffer();
  const photo = await importImage(store, { projectId: project.id, name: "bottle.png", bytes }, { now: harness.now(), newId: randomUUID });
  await seed(harness, "save_product", { projectId: project.id, product: ridgelineProduct([photo.id]) });
  const { script } = (await seed(harness, "save_script", { projectId: project.id, title: "Cold all day", beats: ridgelineBeats() })) as { script: { id: string } };
  await seed(harness, "plan_shots", { projectId: project.id, scriptId: script.id });
  const revision = store.projects.getRequired(project.id).revision;

  const prefer = clean(
    await runTurn(
      harness,
      "Use Nano Banana for product shots from now on.",
      scriptedModel([
        [toolUse("list_recipes", { capability: "image_edit" }, "toolu_list")],
        (params) => {
          const { recipes } = resultJson<{ recipes: { id: string; title: string }[] }>(params.messages, "toolu_list");
          const nano = recipes.find((recipe) => /nano banana pro/i.test(recipe.title)) ?? assert.fail("no Nano Banana recipe listed");
          return [toolUse("set_recipe_preference", { projectId: project.id, capability: "image_edit", recipeId: nano.id }, "toolu_prefer")];
        },
        (params) => {
          assert.match(latestState(params), new RegExp(`Recipe preferences for this project: image_edit uses ${NANO.id}`));
          return say("Done: product stills in this project will use Nano Banana Pro unless you pick another model on a card. Other projects keep your Settings default.");
        },
      ]),
    ),
  );
  usage("set the preference", prefer);
  assert.deepEqual(store.preferences.get(project.id).recipes, { image_edit: NANO.id });
  assert.equal(store.projects.getRequired(project.id).revision, revision, "nothing re-briefed");

  const compose = clean(
    await runTurn(
      harness,
      "Make the start frame for beat 4, the dishwasher shot.",
      scriptedModel([
        (params) => [toolUse("compose_still", { contentId: stateValue(params, "contentId"), beatIndex: 4, count: 1 }, "toolu_still")],
        (params) => {
          const sent = params.messages.flatMap((message) => message.content).find((block) => block.type === "tool_result" && block.tool_use_id === "toolu_still");
          assert.match(String(sent && "content" in sent ? sent.content : ""), /Nano Banana Pro \(test stand-in\).*written in Nano Banana \(Gemini image\) style/s);
          return say("Beat 4's start frame is proposed with Nano Banana Pro, your preference for this project. Approve the card to run it.");
        },
      ]),
    ),
  );
  usage("still with the preference", compose);
  const [nanoCard] = compose.proposals;
  assert.equal(nanoCard.recipeId, NANO.id, "no recipeId was passed; the project preference chose it");
  assert.equal(nanoCard.promptStyle, "gemini-image");
  const [nanoStill] = await approveProposal(tools, nanoCard);
  await seed(harness, "archive_asset", { assetId: nanoStill, reason: "rejected: the rack looks wrong" });

  const retry = clean(
    await runTurn(
      harness,
      "Not that one. Try it with GPT Image instead.",
      scriptedModel([
        [toolUse("list_assets", { projectId: project.id, kind: "image", state: "archived" }, "toolu_assets"), toolUse("list_recipes", { capability: "image_edit" }, "toolu_recipes")],
        (params) => {
          const { assets } = resultJson<{ assets: { id: string }[] }>(params.messages, "toolu_assets");
          const { recipes } = resultJson<{ recipes: { id: string; title: string }[] }>(params.messages, "toolu_recipes");
          const gpt = recipes.find((recipe) => /gpt image/i.test(recipe.title)) ?? assert.fail("no GPT Image recipe listed");
          return [toolUse("regenerate_with", { assetId: assets[0].id, recipeId: gpt.id })];
        },
        say("Proposed the same frame with GPT Image 2; the prompt is rewritten for it. Approve the card to run it."),
      ]),
    ),
  );
  usage("regenerate with another model", retry);
  const [gptCard] = retry.proposals;
  assert.equal(gptCard.recipeId, GPT.id);
  assert.equal(gptCard.promptStyle, "gpt-image");
  assert.deepEqual(gptCard.spec, nanoCard.spec, "the same spec, no re-brief");
  assert.notEqual(gptCard.prompt, nanoCard.prompt);
  assert.match(gptCard.prompt, /^Intended use:/);
  assert.deepEqual(store.preferences.get(project.id).recipes, { image_edit: NANO.id }, "a one-off retry leaves the preference alone");
  assert.equal(store.projects.getRequired(project.id).revision, revision);
});
