/**
 * Recipe tags and the character-start purpose default: the face lock prefers the configured
 * `character_start` recipe only while it is verified and tagged, and otherwise keeps the
 * text-to-image default. Krea 2 is not the default until the v0.2 spike's measured runs pass.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { type Recipe, RecipeSchema, SlotSidecarSchema } from "@/lib/catalog";
import type { GenerationProposal } from "@/lib/domain/job";
import { DEFAULT_PURPOSE_RECIPE_IDS, defaultRecipes, purposeRecipe, purposeRecipeId, WORKFLOW_META } from "@/server/catalog/defaults";
import { loadWorkflowRecipes } from "@/server/catalog/workflows";
import type { ExecutorSet } from "@/server/executors";
import { callTool, type ToolContext } from "@/server/tools";
import { facePrompt, kreaFacePrompt } from "@/server/tools/prompts";
import { averyBible, clock, seedProject, tempStore } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../workflows/", import.meta.url));
const KREA = "krea-2-turbo-t2i";

/** Every recipe runs and estimates as free, so selection is the only thing under test. */
const everything = { forRecipe: () => ({ estimate: async () => ({ kind: "free", note: "test" }) }) } as unknown as ExecutorSet;

function withKrea(recipes: Recipe[], patch: Partial<Recipe>): Recipe[] {
  return recipes.map((recipe) => (recipe.id === KREA ? ({ ...recipe, ...patch } as Recipe) : recipe));
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Configures the purpose default for one test, the way the spike's flip will. */
function configureCharacterStart(id: string): void {
  DEFAULT_PURPOSE_RECIPE_IDS.character_start = id;
  cleanups.push(() => void delete DEFAULT_PURPOSE_RECIPE_IDS.character_start);
}

async function faceSetup(recipes: Recipe[]) {
  const { store, cleanup } = tempStore();
  cleanups.push(cleanup);
  const now = clock();
  const project = seedProject(store, now);
  const context: ToolContext = { store, now, newId: randomUUID, generation: { executors: everything, recipes: async () => recipes } };
  const saved = await callTool(context, "save_character_bible", { projectId: project.id, bible: averyBible() });
  assert.ok(saved.ok);
  const characterId = (saved.output as { character: { id: string; bible: { visualCore: string } } }).character.id;
  const face = async (input: Record<string, unknown> = {}) => {
    const result = await callTool(context, "generate_face_candidates", { projectId: project.id, characterId, count: 1, ...input });
    assert.ok(result.ok, JSON.stringify(result));
    return result.output as GenerationProposal;
  };
  const propose = async (target: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const result = await callTool(context, "propose_candidates", { projectId: project.id, capability: "text_to_image", prompt: "A portrait.", count: 1, target, ...extra });
    assert.ok(result.ok, JSON.stringify(result));
    return result.output as GenerationProposal;
  };
  return { store, now, characterId, face, propose };
}

describe("recipe tags", () => {
  test("recipes and sidecars take known tags and refuse unknown ones", async () => {
    const [recipe] = await defaultRecipes(workflowsDir, { mocks: false });
    assert.deepEqual(RecipeSchema.parse({ ...recipe, tags: ["character_start"] }).tags, ["character_start"]);
    assert.throws(() => RecipeSchema.parse({ ...recipe, tags: ["hero_shot"] }));
    assert.equal(RecipeSchema.parse(recipe).tags, undefined, "tags stay optional");
    const sidecar = SlotSidecarSchema.parse({ workflow: "a.api.json", capability: "text_to_image", outputNode: "1", slots: {}, tags: ["character_start"] });
    assert.deepEqual(sidecar.tags, ["character_start"]);
  });

  test("the loader carries sidecar tags, and the curated table's tags replace them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acl-tags-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await copyFile(join(workflowsDir, `${KREA}.api.json`), join(directory, `${KREA}.api.json`));
    const sidecar = JSON.parse(await readFile(join(workflowsDir, `${KREA}.slots.json`), "utf8"));
    await writeFile(join(directory, `${KREA}.slots.json`), JSON.stringify({ ...sidecar, tags: ["character_start"] }));
    assert.deepEqual((await loadWorkflowRecipes(directory)).recipes[0].tags, ["character_start"]);
    const curated = await loadWorkflowRecipes(directory, { [KREA]: { ...WORKFLOW_META[KREA], tags: [] } });
    assert.deepEqual(curated.recipes[0].tags, []);
  });

  test("today no purpose default is set and Krea 2 is not tagged character_start (the spike's runs decide)", async () => {
    assert.deepEqual(DEFAULT_PURPOSE_RECIPE_IDS, {});
    assert.equal(purposeRecipeId("character_start"), undefined);
    const recipes = await defaultRecipes(workflowsDir, { mocks: false });
    assert.equal(recipes.find((recipe) => recipe.id === KREA)?.tags, undefined);
    assert.equal(purposeRecipe(recipes, "character_start"), undefined);
  });
});

describe("purpose defaults", () => {
  test("a configured purpose recipe counts only when it is in the catalog, verified, and tagged", async () => {
    const recipes = await defaultRecipes(workflowsDir, { mocks: false });
    const ids = { character_start: KREA };
    assert.equal(purposeRecipe(withKrea(recipes, { tags: ["character_start"] }), "character_start", ids)?.id, KREA);
    assert.equal(purposeRecipe(recipes, "character_start", ids), undefined, "untagged");
    assert.equal(purposeRecipe(withKrea(recipes, { tags: ["character_start"], verified: null }), "character_start", ids), undefined, "unverified");
    assert.equal(purposeRecipe(withKrea(recipes, { tags: ["character_start"] }), "character_start", {}), undefined, "not configured");
    assert.equal(purposeRecipe(withKrea(recipes, { tags: ["character_start"] }), "character_start", { character_start: "missing-recipe" }), undefined);

    const tagged = { ...WORKFLOW_META, [KREA]: { ...WORKFLOW_META[KREA], tags: ["character_start" as const] } };
    assert.equal(purposeRecipeId("character_start", ids, tagged), KREA);
    assert.equal(purposeRecipeId("character_start", ids, WORKFLOW_META), undefined);
    assert.equal(purposeRecipeId("character_start", ids, { ...tagged, [KREA]: { ...tagged[KREA], verified: null } }), undefined);
  });

  test("the face lock uses the verified, tagged character-start recipe with its own prompt variant", async () => {
    configureCharacterStart(KREA);
    const recipes = withKrea(await defaultRecipes(workflowsDir, { mocks: true }), { tags: ["character_start"] });
    const { face, propose, characterId } = await faceSetup(recipes);
    const proposal = await face();
    assert.equal(proposal.recipeId, KREA);
    assert.equal(proposal.prompt, kreaFacePrompt(averyBible()));
    const assistant = await propose({ kind: "character_reference", characterId, slot: "face" });
    assert.equal(assistant.recipeId, KREA, "the assistant's face-lock proposal prefers it too");
    assert.equal((await propose({ kind: "loose" })).recipeId, "z-image-turbo-t2i", "other text-to-image steps keep the capability default");
  });

  test("without a tag or a verified run the face lock falls back to the text-to-image default", async () => {
    configureCharacterStart(KREA);
    for (const recipes of [await defaultRecipes(workflowsDir, { mocks: true }), withKrea(await defaultRecipes(workflowsDir, { mocks: true }), { tags: ["character_start"], verified: null })]) {
      const { face } = await faceSetup(recipes);
      const proposal = await face();
      assert.equal(proposal.recipeId, "z-image-turbo-t2i");
      assert.equal(proposal.prompt, facePrompt(averyBible()), "the standard prompt, byte for byte");
    }
  });

  test("a requested recipe or the workspace default wins over the purpose default", async () => {
    configureCharacterStart(KREA);
    const recipes = withKrea(await defaultRecipes(workflowsDir, { mocks: true }), { tags: ["character_start"] });
    const { face, store, now } = await faceSetup(recipes);
    const requested = await face({ recipeId: "z-image-turbo-t2i" });
    assert.equal(requested.recipeId, "z-image-turbo-t2i");
    assert.equal(requested.prompt, facePrompt(averyBible()));
    store.workspace.update({ defaultRecipes: { text_to_image: "flux-2-dev-t2i" } }, now());
    assert.equal((await face()).recipeId, "flux-2-dev-t2i");
    const kreaByName = await face({ recipeId: KREA });
    assert.equal(kreaByName.prompt, kreaFacePrompt(averyBible()), "naming Krea picks its prompt variant even when it is not the default");
  });

  test("a pinned seed is kept on a workflow proposal and dropped for a hosted model, which has no seed slot", async () => {
    const { propose } = await faceSetup(await defaultRecipes(workflowsDir, { mocks: true }));
    assert.equal((await propose({ kind: "loose" }, { recipeId: "z-image-turbo-t2i", seed: 42 })).seed, 42);
    assert.equal((await propose({ kind: "loose" }, { recipeId: "z-image-turbo-t2i" })).seed, undefined);
  });
});
