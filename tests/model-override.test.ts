/**
 * Model override (v0.2 F3) acceptance, offline: a product still made with Qwen Image Edit is
 * rejected, then regenerated with Nano Banana Pro (from the rejected candidate) and with GPT Image 2
 * (from the same proposal card), giving three candidates, three native prompts, one shot spec, and no
 * re-brief. Also the per-project preference and its resolution order, the edited prompt bound, and
 * the server-side re-estimate.
 *
 * The three recipes are test stand-ins: mock-kind recipes that declare the prompt style of the real
 * model (Qwen Image Edit 2511, Nano Banana Pro, GPT Image 2), so the real renderers and the real
 * spending gate run with the credit-free mock executor. GPT Image 2 has no image-edit adapter yet
 * (roadmap 06); prompts-renderers.test.ts covers the real recipe ids' styles.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import sharp from "sharp";
import { MockRecipeSchema, type Recipe } from "@creator-lab/core/catalog";
import type { GenerationProposal } from "@creator-lab/core/domain/job";
import { MOCK_RECIPES } from "@creator-lab/recipes/defaults";
import { type ExecutorSet, MockExecutor } from "@creator-lab/executors";
import { importImage } from "@/server/media/images";
import { type ToolContext, callTool } from "@/server/tools";
import { clock, ridgelineBeats, ridgelineProduct, seedProject, tempStore } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function standIn(id: string, title: string, promptStyle: "standard" | "gemini-image" | "gpt-image", maxReferences: number): Recipe {
  return MockRecipeSchema.parse({
    id,
    kind: "mock",
    title,
    capability: "image_edit",
    openWeights: promptStyle === "standard",
    verified: null,
    costHint: "Test stand-in on the mock executor.",
    ceilingUsd: 0.25,
    limits: { maxReferences },
    defaults: { aspectRatio: "9:16" },
    promptStyle,
  });
}

const QWEN = standIn("test-qwen-image-edit-2511-1ref", "Qwen Image Edit 2511, one reference (test stand-in)", "standard", 1);
const NANO = standIn("test-nano-banana-pro-edit", "Nano Banana Pro (test stand-in)", "gemini-image", 14);
const GPT = standIn("test-gpt-image-2-edit", "GPT Image 2 edit (test stand-in)", "gpt-image", 16);

/** GPT Image prompts are priced at 4 cents so the card's re-estimate is visible; the rest are free. */
const gptPrice = (input: { prompt: string }) => (input.prompt.startsWith("Intended use:") ? 0.04 : undefined);

async function setup() {
  const { store, cleanup } = tempStore();
  cleanups.push(cleanup);
  const now = clock();
  const mock = new MockExecutor({ jobs: store.jobs, price: gptPrice });
  const executors = { mock, forRecipe: (recipe) => (recipe.kind === "mock" ? mock : undefined) } as ExecutorSet;
  const tools: ToolContext = {
    store,
    now,
    newId: randomUUID,
    generation: { executors, recipes: async () => [...MOCK_RECIPES, QWEN, NANO, GPT], allowanceUsd: () => 5, operatorCeilingUsd: () => 5 },
  };
  const project = seedProject(store, now);
  const ok = async <T = Record<string, unknown>>(name: string, input: unknown): Promise<T> => {
    const result = await callTool(tools, name, input);
    if (!result.ok) assert.fail(`${name} failed: ${result.failure.code} ${result.failure.message}`);
    return result.output as T;
  };
  const bytes = await sharp({ create: { width: 64, height: 96, channels: 3, background: "#2f4a3a" } }).png().toBuffer();
  const photo = await importImage(store, { projectId: project.id, name: "bottle.png", bytes }, { now: now(), newId: randomUUID });
  await ok("save_product", { projectId: project.id, product: ridgelineProduct([photo.id]) });
  const { script } = await ok<{ script: { id: string } }>("save_script", { projectId: project.id, title: "Cold all day", beats: ridgelineBeats() });
  const content = await ok<{ id: string }>("plan_shots", { projectId: project.id, scriptId: script.id });
  const submit = async (proposal: GenerationProposal) => {
    const { results } = await ok<{ results: { outcome: string; assetIds: string[]; message: string | null }[] }>("submit_proposal", { proposal, wait: true });
    assert.deepEqual(results.map((result) => result.outcome), ["completed"], JSON.stringify(results));
    return results[0].assetIds[0];
  };
  return { store, tools, project, contentId: content.id, scriptId: script.id, photo, ok, submit };
}

describe("model override acceptance", () => {
  test("a rejected Qwen product still is regenerated with Nano Banana Pro and GPT Image 2: three candidates, three native prompts, no re-brief", async () => {
    const { store, project, contentId, scriptId, ok, submit } = await setup();
    const projectRevision = store.projects.getRequired(project.id).revision;
    const scriptVersion = store.scripts.getRequired(scriptId).version;

    // Beat 4 is b-roll with the product visible: an image edit from the product photo.
    const qwenCard = await ok<GenerationProposal>("compose_still", { contentId, beatIndex: 4, recipeId: QWEN.id, count: 1 });
    assert.equal(qwenCard.recipeId, QWEN.id);
    assert.equal(qwenCard.promptStyle, "standard");
    assert.equal(qwenCard.spec?.kind, "still");
    assert.match(qwenCard.prompt, /^Close detail shot\. The bottle going into a dishwasher rack\..*The product in reference image 1 is a matte dark green/);
    const qwenStill = await submit(qwenCard);

    // The user rejects it.
    await ok("archive_asset", { assetId: qwenStill, reason: "rejected: the bottle looks plastic" });
    assert.equal(store.assets.getRequired(qwenStill).state.state, "archived");

    // The selector lists all three for the rejected candidate's job.
    const options = await ok<{ capability: string; references: number; options: { id: string; fits: boolean; promptStyle: string }[] }>("recipe_options", { projectId: project.id, assetId: qwenStill });
    assert.equal(options.capability, "image_edit");
    assert.equal(options.references, 1);
    for (const recipe of [QWEN, NANO, GPT]) assert.ok(options.options.some((option) => option.id === recipe.id && option.fits), recipe.id);
    assert.equal(options.options.find((option) => option.id === NANO.id)?.promptStyle, "gemini-image");

    // "Regenerate with..." on the rejected candidate: Nano Banana Pro.
    const nanoCard = await ok<GenerationProposal>("regenerate_with", { assetId: qwenStill, recipeId: NANO.id });
    assert.equal(nanoCard.promptStyle, "gemini-image");
    assert.match(nanoCard.prompt, /^A candid vertical close-up phone photo for a UGC video ad.*The product from the first image, a matte dark green/);
    assert.deepEqual(nanoCard.target, qwenCard.target);
    assert.deepEqual(nanoCard.references, qwenCard.references);
    const nanoStill = await submit(nanoCard);

    // The same proposal card, switched to GPT Image 2 through the server.
    const gptCard = await ok<GenerationProposal>("rerender_proposal", { proposal: qwenCard, recipeId: GPT.id });
    assert.notEqual(gptCard.id, qwenCard.id, "a new recipe is a new proposal, so its candidates get their own request ids");
    assert.equal(gptCard.promptStyle, "gpt-image");
    assert.match(gptCard.prompt, /^Intended use: the start frame of one beat.*\n- Image 1: product photo; reproduce this exact product/s);
    assert.equal(gptCard.estimate.kind, "quoted", "the estimate is redone on the server for the new recipe");
    assert.equal(gptCard.estimate.usd, 0.04);
    assert.equal(qwenCard.estimate.kind, "free");
    const gptStill = await submit(gptCard);

    // Three candidates on beat 4, three native prompts, one spec, nothing re-briefed.
    const jobs = [qwenStill, nanoStill, gptStill].map((assetId) => {
      const asset = store.assets.getRequired(assetId);
      assert.ok(asset.provenance.source === "generated");
      return store.jobs.get(asset.provenance.jobId)!;
    });
    assert.deepEqual(jobs.map((job) => job.recipeId), [QWEN.id, NANO.id, GPT.id]);
    assert.equal(new Set(jobs.map((job) => job.request.input.prompt)).size, 3);
    assert.deepEqual(jobs.map((job) => job.request.input.prompt), [qwenCard.prompt, nanoCard.prompt, gptCard.prompt]);
    for (const job of jobs) {
      assert.deepEqual(job.request.spec, qwenCard.spec);
      assert.deepEqual(job.request.target, { kind: "shot", contentId, beatIndex: 4, slot: "still" });
    }
    const shot = store.content.getRequired(contentId).shots[3];
    assert.equal(shot.still.state, "open");
    assert.deepEqual(shot.still.state === "open" ? [...shot.still.candidateIds].sort() : [], [qwenStill, nanoStill, gptStill].sort());
    assert.deepEqual([qwenStill, nanoStill, gptStill].map((id) => store.assets.getRequired(id).state.state), ["archived", "active", "active"]);
    assert.equal(store.projects.getRequired(project.id).revision, projectRevision, "no re-brief");
    assert.equal(store.scripts.getRequired(scriptId).version, scriptVersion, "no script change");
  });
});

describe("per-project recipe preference", () => {
  test("resolution: explicit choice, then the project preference, then the Settings default, then the app's", async () => {
    const { store, tools, project, contentId, ok } = await setup();
    const still = (recipeId?: string) => ok<GenerationProposal>("compose_still", { contentId, beatIndex: 4, count: 1, ...(recipeId ? { recipeId } : {}) });

    assert.equal((await still()).recipeId, QWEN.id, "nothing set: the app's choice (open weights first)");
    store.workspace.update({ defaultRecipes: { image_edit: GPT.id } }, tools.now());
    assert.equal((await still()).recipeId, GPT.id, "the Settings default");

    const revision = store.projects.getRequired(project.id).revision;
    const saved = await ok<{ recipeTitle: string; note: string; preferences: { recipes: Record<string, string> } }>("set_recipe_preference", {
      projectId: project.id,
      capability: "image_edit",
      recipeId: NANO.id,
    });
    assert.equal(saved.recipeTitle, NANO.title);
    assert.deepEqual(saved.preferences.recipes, { image_edit: NANO.id });
    assert.match(saved.note, /this project's image edit recipe/);
    assert.equal(store.projects.getRequired(project.id).revision, revision, "a preference never bumps the project revision");

    const preferred = await still();
    assert.equal(preferred.recipeId, NANO.id, "the project preference beats the Settings default");
    assert.equal(preferred.promptStyle, "gemini-image");
    assert.equal((await still(QWEN.id)).recipeId, QWEN.id, "an explicit per-run choice beats the preference");

    const state = await ok<{ preferences: { recipes: Record<string, string> } }>("get_project_state", { projectId: project.id });
    assert.deepEqual(state.preferences.recipes, { image_edit: NANO.id });

    const other = seedProject(store, tools.now, "Gym bag launch");
    assert.deepEqual(store.preferences.get(other.id).recipes, {}, "preferences are per project");

    await ok("set_recipe_preference", { projectId: project.id, capability: "image_edit", recipeId: null });
    assert.equal((await still()).recipeId, GPT.id, "cleared: the Settings default applies again");
  });

  test("a preference must name a recipe of that capability", async () => {
    const { tools, project } = await setup();
    const wrong = await callTool(tools, "set_recipe_preference", { projectId: project.id, capability: "text_to_image", recipeId: NANO.id });
    assert.equal(!wrong.ok && wrong.failure.code, "invalid");
    assert.match(!wrong.ok ? wrong.failure.message : "", /does image edit, not text to image/);
    const missing = await callTool(tools, "set_recipe_preference", { projectId: project.id, capability: "image_edit", recipeId: "no-such-recipe" });
    assert.equal(!missing.ok && missing.failure.code, "not_found");
    const scope = await callTool(tools, "set_recipe_preference", { projectId: project.id, capability: "image_edit", recipeId: NANO.id, scope: "workspace" });
    assert.equal(!scope.ok && scope.failure.code, "invalid", "the workspace default lives in Settings, not here");
  });

  test("a preference that cannot take the step's references is skipped, not forced", async () => {
    const { tools, project, contentId, ok } = await setup();
    // Beat 4's still has one reference (the product photo); a zero-reference preference cannot take it.
    const zero = standIn("test-no-references", "No references (test)", "standard", 0);
    const recipes = await tools.generation!.recipes();
    tools.generation!.recipes = async () => [...recipes, zero];
    await ok("set_recipe_preference", { projectId: project.id, capability: "image_edit", recipeId: zero.id });
    assert.equal((await ok<GenerationProposal>("compose_still", { contentId, beatIndex: 4, count: 1 })).recipeId, QWEN.id, "the app's choice");
  });
});

describe("the proposal card's prompt and estimate", () => {
  test("an edited prompt is what runs, bounded on the server; an unedited one is rendered by the server", async () => {
    const { store, tools, contentId, ok } = await setup();
    const card = await ok<GenerationProposal>("compose_still", { contentId, beatIndex: 4, recipeId: QWEN.id, count: 1 });

    const tooLong = await callTool(tools, "submit_proposal", { proposal: { ...card, prompt: "x".repeat(8001), promptEdited: true }, wait: true });
    assert.equal(tooLong.ok, false);
    assert.match(!tooLong.ok ? tooLong.failure.message : "", /under 8000 characters/);
    assert.equal(store.jobs.listByProject(card.projectId).length, 0, "nothing ran");

    const edited = "Close detail shot of the bottle in a dishwasher rack, morning light. No text in the image.";
    const run = await ok<{ results: { assetIds: string[] }[] }>("submit_proposal", { proposal: { ...card, prompt: `  ${edited}\n\n`, promptEdited: true }, wait: true });
    const asset = store.assets.getRequired(run.results[0].assetIds[0]);
    assert.ok(asset.provenance.source === "generated");
    assert.equal(store.jobs.get(asset.provenance.jobId)!.request.input.prompt, edited);

    // A prompt changed without the edit flag is not trusted: the server renders the spec itself.
    const again = await ok<GenerationProposal>("compose_still", { contentId, beatIndex: 4, recipeId: QWEN.id, count: 1 });
    const tampered = await ok<{ results: { assetIds: string[] }[] }>("submit_proposal", { proposal: { ...again, prompt: "Something else entirely" }, wait: true });
    const second = store.assets.getRequired(tampered.results[0].assetIds[0]);
    assert.ok(second.provenance.source === "generated");
    assert.equal(store.jobs.get(second.provenance.jobId)!.request.input.prompt, again.prompt);
  });

  test("switching the recipe refuses one that cannot take the references, and keeps the spec", async () => {
    const { tools, contentId, ok } = await setup();
    const zero = standIn("test-no-references", "No references (test)", "standard", 0);
    const recipes = await tools.generation!.recipes();
    tools.generation!.recipes = async () => [...recipes, zero];
    const card = await ok<GenerationProposal>("compose_still", { contentId, beatIndex: 4, recipeId: QWEN.id, count: 1 });
    const refused = await callTool(tools, "rerender_proposal", { proposal: card, recipeId: zero.id });
    assert.equal(!refused.ok && refused.failure.code, "invalid");
    assert.match(!refused.ok ? refused.failure.message : "", /takes 0 to 0 reference images; this step has 1/);
    const nano = await ok<GenerationProposal>("rerender_proposal", { proposal: card, recipeId: NANO.id, count: 2 });
    assert.equal(nano.count, 2);
    assert.deepEqual(nano.spec, card.spec);
    const options = await ok<{ options: { id: string; fits: boolean; reason: string | null }[] }>("recipe_options", { projectId: card.projectId, capability: "image_edit", references: 1 });
    const unfit = options.options.find((option) => option.id === zero.id);
    assert.equal(unfit?.fits, false);
    assert.match(unfit?.reason ?? "", /Takes 0 reference images; this step has 1/);
  });

  test("a proposal saved before shot specs keeps its prompt as written on another recipe", async () => {
    const { tools, contentId, ok } = await setup();
    const card = await ok<GenerationProposal>("compose_still", { contentId, beatIndex: 4, recipeId: QWEN.id, count: 1 });
    const legacy: GenerationProposal = { ...card, spec: undefined, promptStyle: undefined };
    const moved = await ok<GenerationProposal>("rerender_proposal", { proposal: legacy, recipeId: NANO.id });
    assert.equal(moved.prompt, card.prompt);
    assert.equal(moved.spec?.kind, "free");
    const tooLong = await callTool(tools, "rerender_proposal", { proposal: { ...legacy, prompt: "word ".repeat(1700) }, recipeId: NANO.id });
    assert.equal(!tooLong.ok && tooLong.failure.code, "invalid");
    assert.match(!tooLong.ok ? tooLong.failure.message : "", /^This prompt is 8,499 characters, longer than the 8,000 another recipe takes\. Shorten it on the card first\.$/);
  });

  test("regenerate_with refuses a projectId that is not the candidate's", async () => {
    const { tools, store, contentId, ok, submit } = await setup();
    const card = await ok<GenerationProposal>("compose_still", { contentId, beatIndex: 4, recipeId: QWEN.id, count: 1 });
    const still = await submit(card);
    const other = seedProject(store, tools.now, "Gym bag launch");
    const refused = await callTool(tools, "regenerate_with", { assetId: still, projectId: other.id, recipeId: NANO.id });
    assert.equal(!refused.ok && refused.failure.message, "This candidate belongs to another project.");
    const own = await ok<GenerationProposal>("regenerate_with", { assetId: still, projectId: card.projectId, recipeId: NANO.id });
    assert.equal(own.projectId, card.projectId);
  });
});
