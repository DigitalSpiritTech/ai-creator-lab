/**
 * Recipe choice for a proposal: the requested id, then the Settings default, then the starter default,
 * then open weights that take this many references, then the hosted alternative.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { defaultRecipes } from "@/server/catalog/defaults";
import type { ExecutorSet } from "@/server/executors";
import { pickRecipe } from "@/server/tools/proposals";

const workflowsDir = fileURLToPath(new URL("../workflows/", import.meta.url));
const everything = { forRecipe: () => ({}) } as unknown as ExecutorSet;

test("image edits stay on open weights for one, two and three references before any hosted model", async () => {
  const recipes = await defaultRecipes(workflowsDir, { mocks: true });
  assert.equal(pickRecipe(recipes, everything, "image_edit", 1, [undefined]).id, "qwen-image-edit-2511-1ref");
  assert.equal(pickRecipe(recipes, everything, "image_edit", 2, [undefined]).id, "qwen-image-edit-2511-2ref");
  assert.equal(pickRecipe(recipes, everything, "image_edit", 3, [undefined]).id, "qwen-image-edit-2511-3ref");
  assert.equal(pickRecipe(recipes, everything, "image_edit", 4, [undefined]).id, "router-nano-banana-2.1-edit", "four references need a hosted model");
});

test("a Settings default that fits wins; one that does not fit falls back to open weights, not to the hosted model", async () => {
  const recipes = await defaultRecipes(workflowsDir, { mocks: true });
  assert.equal(pickRecipe(recipes, everything, "image_edit", 2, [undefined, "router-nano-banana-pro-edit"]).id, "router-nano-banana-pro-edit");
  assert.equal(pickRecipe(recipes, everything, "image_edit", 1, [undefined, "qwen-image-edit-2511-2ref"]).id, "qwen-image-edit-2511-1ref");
  assert.equal(pickRecipe(recipes, everything, "image_to_video", 1, [undefined, "router-kling-3-omni-i2v"]).id, "router-kling-3-omni-i2v");
});

test("a requested recipe that cannot take the references is refused rather than swapped", async () => {
  const recipes = await defaultRecipes(workflowsDir, { mocks: true });
  assert.throws(() => pickRecipe(recipes, everything, "image_edit", 3, ["qwen-image-edit-2511-2ref"]), /takes 2 to 2 reference images/);
});
