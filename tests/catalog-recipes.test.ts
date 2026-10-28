/**
 * Slot sidecars, workflow recipe loading, and the starter recipe set.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  applySlots,
  imageSlotNames,
  MVP_CAPABILITIES,
  RecipeSchema,
  sidecarProblems,
  SlotSidecarSchema,
  snapLength,
  WorkflowGraphSchema,
} from "@/lib/catalog";
import { defaultRecipes, DEFAULT_RECIPE_IDS, recipesFor } from "@/server/catalog/defaults";
import { loadWorkflowRecipes } from "@/server/catalog/workflows";

const workflowsDir = fileURLToPath(new URL("../workflows", import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(join(workflowsDir, name), "utf8"));
const NAMES = [
  "z-image-turbo-t2i",
  "qwen-image-edit-2511-1ref",
  "qwen-image-edit-2511-2ref",
  "qwen-image-edit-2511-3ref",
  "qwen-image-2512-t2i",
  "flux-2-dev-t2i",
  "flux-2-dev-edit-1ref",
  "flux-2-dev-edit-2ref",
  "flux-2-dev-edit-3ref",
  "krea-2-turbo-t2i",
  "krea-2-turbo-style-reference",
  "minimax-h3-t2i",
  "minimax-h3-t2v",
  "minimax-h3-i2v",
  "minimax-h3-flf2v",
  "wan-2.2-t2v",
  "wan-2.2-i2v",
  "wan-2.2-flf2v",
  "ltx-2.5-i2v",
  "ltx-2.5-flf2v",
  "chatterbox-turbo-tts",
  "qwen3-tts-voice-clone",
  "wan-2.2-s2v",
];

test("every starter sidecar parses and matches its workflow graph", () => {
  for (const name of NAMES) {
    const sidecar = SlotSidecarSchema.parse(read(`${name}.slots.json`));
    const graph = WorkflowGraphSchema.parse(read(sidecar.workflow));
    assert.deepEqual(sidecarProblems(sidecar, graph), [], name);
  }
  const edit = SlotSidecarSchema.parse(read("qwen-image-edit-2511-2ref.slots.json"));
  assert.deepEqual(imageSlotNames(edit), ["image1", "image2"]);
});

test("slot application writes list bindings to every node and refuses unknown or mistyped slots", () => {
  const sidecar = SlotSidecarSchema.parse(read("ltx-2.5-i2v.slots.json"));
  const graph = WorkflowGraphSchema.parse(read("ltx-2.5-i2v.api.json"));
  const writes: [string, string, unknown][] = [];
  const target = { setInput: (node: string, field: string, value: unknown) => writes.push([node, field, value]) };
  applySlots(target, sidecar, { prompt: "She smiles", length: 97, image: { asset: "start.png" }, seed: 5, width: undefined });
  assert.deepEqual(writes, [
    ["5", "text", "She smiles"],
    ["8", "length", 97],
    ["10", "frames_number", 97],
    ["22", "image", { asset: "start.png" }],
    ["12", "noise_seed", 5],
  ]);
  assert.throws(() => applySlots(target, sidecar, { negative: "blur" }), /no slot named negative/);
  assert.throws(() => applySlots(target, sidecar, { prompt: { not: "text" } }), /plain value/);
  const broken = { ...sidecar, outputNode: "99", slots: { ...sidecar.slots, seed: { node: "12", input: "seed" } } };
  assert.deepEqual(sidecarProblems(broken, graph), ["Output node 99 is missing.", "Slot seed: node 12 has no input seed."]);
  const imageOnText = { ...sidecar, slots: { ...sidecar.slots, image: { node: "5", input: "text", kind: "image" as const } } };
  assert.match(sidecarProblems(imageOnText, graph).join(" "), /must bind a LoadImage node/);
});

test("lengths snap to the 8n+1 rule", () => {
  assert.equal(snapLength(120, "8n+1"), 121);
  assert.equal(snapLength(121, "8n+1"), 121);
  assert.equal(snapLength(100, "8n+1"), 97);
  assert.equal(snapLength(100), 100);
  assert.equal(snapLength(80, "4n+1"), 81, "Wan 2.2 at 16 fps for 5 s");
  assert.equal(snapLength(120, "17n+5"), 124, "MiniMax H3 at 24 fps for 5 s");
  assert.equal(snapLength(2, "17n+5"), 5, "never below the offset");
  assert.equal(snapLength(48, "4n+1", 77), 49, "a 3 s take at 16 fps for S2V");
  assert.equal(snapLength(130, "4n+1", 77), 77, "one S2V chunk at most");
  assert.equal(snapLength(76, "4n+1", 76), 73, "snapping never lands above the limit");
});

test("the workflow loader builds recipes from sidecars and reports broken ones without failing", async () => {
  const loaded = await loadWorkflowRecipes(workflowsDir);
  assert.deepEqual(loaded.recipes.map((recipe) => recipe.id).sort(), [...NAMES].sort());
  assert.deepEqual(loaded.problems, []);
  assert.ok(loaded.recipes.every((recipe) => recipe.verified === null), "verification comes from the curated table, not the sidecar");
  const directory = await mkdtemp(join(tmpdir(), "acl-catalog-"));
  try {
    await copyFile(join(workflowsDir, "z-image-turbo-t2i.api.json"), join(directory, "z-image-turbo-t2i.api.json"));
    await copyFile(join(workflowsDir, "z-image-turbo-t2i.slots.json"), join(directory, "z-image-turbo-t2i.slots.json"));
    const bad = { ...read("z-image-turbo-t2i.slots.json"), slots: { prompt: { node: "404", input: "text" } } };
    await writeFile(join(directory, "custom-bad.slots.json"), JSON.stringify({ ...bad, workflow: "z-image-turbo-t2i.api.json" }));
    const mixed = await loadWorkflowRecipes(directory);
    assert.deepEqual(mixed.recipes.map((recipe) => recipe.id), ["z-image-turbo-t2i"]);
    assert.equal(mixed.problems[0].file, "custom-bad.slots.json");
    assert.match(mixed.problems[0].problem, /node 404 is missing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("starter recipes match the spike: verified defaults per MVP capability, unverified alternatives labeled", async () => {
  const recipes = await defaultRecipes(workflowsDir, { mocks: true });
  for (const recipe of recipes) RecipeSchema.parse(recipe);
  assert.equal(new Set(recipes.map((recipe) => recipe.id)).size, recipes.length);
  const summary = Object.fromEntries(recipes.filter((recipe) => recipe.kind !== "mock").map((recipe) => [recipe.id, [recipe.kind, recipe.capability, recipe.verified]]));
  assert.deepEqual(summary, {
    "chatterbox-turbo-tts": ["workflow", "text_to_speech", "2026-10-28"],
    "qwen3-tts-voice-clone": ["workflow", "text_to_speech", "2026-10-28"],
    "flux-2-dev-edit-1ref": ["workflow", "image_edit", "2026-10-27"],
    "flux-2-dev-edit-2ref": ["workflow", "image_edit", null],
    "flux-2-dev-edit-3ref": ["workflow", "image_edit", "2026-10-27"],
    "flux-2-dev-t2i": ["workflow", "text_to_image", "2026-10-27"],
    "krea-2-turbo-style-reference": ["workflow", "image_edit", "2026-10-27"],
    "krea-2-turbo-t2i": ["workflow", "text_to_image", "2026-10-27"],
    "ltx-2.5-i2v": ["workflow", "image_to_video", "2026-10-26"],
    "ltx-2.5-flf2v": ["workflow", "first_last_to_video", "2026-10-26"],
    "minimax-h3-flf2v": ["workflow", "first_last_to_video", "2026-10-27"],
    "minimax-h3-i2v": ["workflow", "image_to_video", "2026-10-27"],
    "minimax-h3-t2i": ["workflow", "text_to_image", "2026-10-27"],
    "minimax-h3-t2v": ["workflow", "text_to_video", "2026-10-27"],
    "qwen-image-2512-t2i": ["workflow", "text_to_image", "2026-10-27"],
    "qwen-image-edit-2511-1ref": ["workflow", "image_edit", "2026-10-27"],
    "qwen-image-edit-2511-2ref": ["workflow", "image_edit", "2026-10-26"],
    "qwen-image-edit-2511-3ref": ["workflow", "image_edit", "2026-10-27"],
    "wan-2.2-flf2v": ["workflow", "first_last_to_video", "2026-10-27"],
    "wan-2.2-s2v": ["workflow", "speech_to_video", "2026-10-28"],
    "wan-2.2-i2v": ["workflow", "image_to_video", "2026-10-27"],
    "wan-2.2-t2v": ["workflow", "text_to_video", "2026-10-27"],
    "z-image-turbo-t2i": ["workflow", "text_to_image", "2026-10-26"],
    "router-nano-banana-2.1-edit": ["router", "image_edit", "2026-10-26"],
    "router-nano-banana-pro-edit": ["router", "image_edit", "2026-10-27"],
    "router-nano-banana-pro-t2i": ["router", "text_to_image", null],
    "router-kling-3-omni-i2v": ["router", "image_to_video", "2026-10-27"],
    "router-kling-3-omni-flf2v": ["router", "first_last_to_video", null],
    "router-ltx-2.5-fast": ["router", "text_to_video", null],
    "router-wan-3-i2v": ["router", "image_to_video", null],
    "router-wan-3-flf2v": ["router", "first_last_to_video", null],
  });
  for (const capability of MVP_CAPABILITIES) {
    const ranked = recipesFor(recipes, capability);
    assert.ok(ranked[0].verified && ranked[0].kind !== "mock", capability);
    assert.equal(ranked.at(-1)!.kind, "mock");
    const ids = DEFAULT_RECIPE_IDS[capability]!;
    for (const id of [ids.primary, ids.hosted, ids.mock].filter((value): value is string => !!value)) {
      assert.equal(recipes.find((recipe) => recipe.id === id)?.capability, capability, id);
    }
  }
  const ltx = recipes.find((recipe) => recipe.id === "ltx-2.5-i2v");
  assert.ok(ltx?.kind === "workflow" && ltx.fitImages);
  assert.ok(recipes.filter((recipe) => recipe.kind !== "mock").every((recipe) => recipe.ceilingUsd !== undefined));
});

test("the first-and-last LTX sidecar binds both frames, both lengths, and both guide strengths", async () => {
  const sidecar = SlotSidecarSchema.parse(read("ltx-2.5-flf2v.slots.json"));
  const graph = WorkflowGraphSchema.parse(read(sidecar.workflow));
  assert.deepEqual(sidecarProblems(sidecar, graph), []);
  assert.equal(sidecar.verified, null);
  assert.deepEqual(imageSlotNames(sidecar), ["first", "last"]);
  assert.deepEqual(sidecar.limits, SlotSidecarSchema.parse(read("ltx-2.5-i2v.slots.json")).limits);
  assert.deepEqual([graph["22"].inputs.image, graph["25"].inputs.image], ["first.png", "last.png"]);
  assert.deepEqual([graph["24"].inputs.frame_idx, graph["27"].inputs.frame_idx], [0, -1]);
  assert.equal(graph["9"].inputs.filename_prefix, "ai-creator-lab/ltx-flf2v");
  const writes: [string, string, unknown][] = [];
  applySlots({ setInput: (node, field, value) => writes.push([node, field, value]) }, sidecar, {
    first: { asset: "first" },
    last: { asset: "last" },
    length: 97,
    firstStrength: 0.9,
    lastStrength: 0.6,
  });
  assert.deepEqual(writes, [
    ["22", "image", { asset: "first" }],
    ["25", "image", { asset: "last" }],
    ["8", "length", 97],
    ["10", "frames_number", 97],
    ["24", "strength", 0.9],
    ["27", "strength", 0.6],
  ]);

  const recipes = await defaultRecipes(workflowsDir, { mocks: true });
  const ranked = recipesFor(recipes, "first_last_to_video");
  assert.deepEqual(ranked.map((recipe) => recipe.id), ["ltx-2.5-flf2v", "minimax-h3-flf2v", "wan-2.2-flf2v", "router-kling-3-omni-flf2v", "router-wan-3-flf2v", "mock-first-last-to-video"]);
  const flf = ranked[0];
  assert.ok(flf.kind === "workflow" && flf.fitImages && flf.openWeights && flf.verified === "2026-10-26");
  assert.deepEqual(DEFAULT_RECIPE_IDS.first_last_to_video, { primary: "ltx-2.5-flf2v", hosted: "router-kling-3-omni-flf2v", mock: "mock-first-last-to-video" });
});

test("mock recipes stay out of the catalog unless MOCK_RECIPES=1 or the caller asks for them", async () => {
  const previous = process.env.MOCK_RECIPES;
  try {
    delete process.env.MOCK_RECIPES;
    const hidden = await defaultRecipes(workflowsDir);
    assert.equal(hidden.filter((recipe) => recipe.kind === "mock").length, 0);
    assert.ok(hidden.some((recipe) => recipe.id === "ltx-2.5-i2v"));
    process.env.MOCK_RECIPES = "1";
    const listed = await defaultRecipes(workflowsDir);
    assert.equal(listed.filter((recipe) => recipe.kind === "mock").length, 7);
    assert.equal((await defaultRecipes(workflowsDir, { mocks: true })).filter((recipe) => recipe.kind === "mock").length, 7);
  } finally {
    if (previous === undefined) delete process.env.MOCK_RECIPES;
    else process.env.MOCK_RECIPES = previous;
  }
});
