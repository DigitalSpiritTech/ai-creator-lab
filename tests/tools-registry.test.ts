import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { importImage } from "@/server/media/images";
import { TOOLS, type ToolContext, callTool, createGenerationContext, toolsToJsonSchema } from "@/server/tools";
import { averyBible, clock, generateAssets, ridgelineBeats, seedProject, tempStore } from "./support/domain-fixtures";

const ROSTER = [
  "get_project_state",
  "save_brief",
  "save_character_bible",
  "propose_candidates",
  "select_reference",
  "generate_reference_sheet",
  "save_product",
  "save_script",
  "plan_shots",
  "compose_still",
  "refine_still",
  "generate_clip",
  "approve",
  "archive_asset",
  "delete_asset_everywhere",
  "assemble_ad",
  "list_assets",
  "list_recipes",
];

const workflowsDir = fileURLToPath(new URL("../workflows", import.meta.url));

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const generation = createGenerationContext(context.store, { workflowsDir });
  const tools: ToolContext = { store: context.store, now, newId: randomUUID, generation };
  return { ...context, now, tools, project: seedProject(context.store, now) };
}

async function ok<T = Record<string, unknown>>(tools: ToolContext, name: string, input: unknown): Promise<T> {
  const result = await callTool(tools, name, input);
  if (!result.ok) assert.fail(`${name} failed: ${result.failure.code} ${result.failure.message}`);
  return result.output as T;
}

describe("registry", () => {
  test("registers the roster in order and converts every input to an object JSON schema", () => {
    assert.deepEqual(TOOLS.map((tool) => tool.name), ROSTER);
    const schemas = toolsToJsonSchema();
    assert.equal(schemas.length, ROSTER.length);
    for (const schema of schemas) {
      assert.equal(schema.input_schema.type, "object", schema.name);
      assert.equal("$schema" in schema.input_schema, false);
      assert.ok(schema.description && schema.description.length > 20, schema.name);
    }
    const approve = schemas.find((schema) => schema.name === "approve")!;
    assert.deepEqual(approve.input_schema.required, ["kind", "assetId"]);
  });

  test("unknown tools and invalid input come back as invalid failures", async () => {
    const { tools } = setup();
    assert.deepEqual(await callTool(tools, "nope", {}), { ok: false, failure: { code: "invalid", message: "Unknown tool nope." } });
    const bad = await callTool(tools, "save_brief", { projectId: "x" });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.failure.code, "invalid");
    const missing = await callTool(tools, "get_project_state", { projectId: randomUUID() });
    assert.equal(!missing.ok && missing.failure.code, "not_found");
  });

  test("generation tools fail cleanly without a generation context", async () => {
    const { tools, project } = setup();
    const result = await callTool({ ...tools, generation: undefined }, "propose_candidates", {
      projectId: project.id,
      capability: "text_to_image",
      prompt: "Avery portrait",
    });
    assert.deepEqual(result, { ok: false, failure: { code: "invalid", message: "Generation is not configured for this session." } });
    assert.equal(toolsToJsonSchema().some((schema) => schema.name === "submit_proposal"), false);
  });

  test("list_recipes filters by capability and flags verified, open weights, and availability", async () => {
    const { tools } = setup();
    const { recipes } = await ok<{ recipes: { id: string; kind: string; verified: boolean; openWeights: boolean; available: boolean }[] }>(
      tools,
      "list_recipes",
      { capability: "image_edit" },
    );
    assert.equal(recipes[0].id, "qwen-image-edit-2511-2ref");
    assert.equal(recipes[0].verified, true);
    assert.equal(recipes[0].openWeights, true);
    assert.equal(recipes.at(-1)!.kind, "mock");
    assert.equal(recipes.at(-1)!.available, true);
  });
});

describe("store-backed tools", () => {
  test("brief, bible, references, product, script, shots, approvals, archive, delete, and listing", async () => {
    const { store, now, tools, project } = setup();

    const state = await ok<{ project: { id: string }; characters: unknown[] }>(tools, "get_project_state", { projectId: project.id });
    assert.equal(state.project.id, project.id);

    const briefed = await ok<{ revision: number }>(tools, "save_brief", {
      projectId: project.id,
      revision: 0,
      brief: { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters", platforms: ["TikTok", "Reels"], tone: "Warm, direct" },
    });
    assert.equal(briefed.revision, 1);
    const stale = await callTool(tools, "save_brief", {
      projectId: project.id,
      revision: 0,
      brief: { productSummary: "x", audience: "y", platforms: ["TikTok"], tone: "z" },
    });
    assert.equal(!stale.ok && stale.failure.code, "conflict");

    const saved = await ok<{ character: { id: string; revision: number }; link: { wardrobe: string } }>(tools, "save_character_bible", {
      projectId: project.id,
      wardrobe: "Oatmeal knit sweater and jeans",
      bible: averyBible(),
    });
    assert.equal(saved.link.wardrobe, "Oatmeal knit sweater and jeans");
    const characterId = saved.character.id;
    const revisedBible = await ok<{ character: { bible: { version: number } } }>(tools, "save_character_bible", {
      characterId,
      revision: saved.character.revision,
      bible: { ...averyBible(), build: "Tall and athletic" },
    });
    assert.equal(revisedBible.character.bible.version, 2);

    const faces = await generateAssets(store, now, { projectId: project.id, count: 4, target: { kind: "character_reference", characterId, slot: "face" } });
    const face = await ok<{ character: { bible: { references: { faceAssetId: string }; version: number } }; archivedAssetIds: string[] }>(
      tools,
      "select_reference",
      { characterId, slot: "face", assetId: faces.assetIds[1] },
    );
    assert.equal(face.character.bible.references.faceAssetId, faces.assetIds[1]);
    assert.equal(face.character.bible.version, 3);
    assert.deepEqual(face.archivedAssetIds.sort(), [faces.assetIds[0], faces.assetIds[2], faces.assetIds[3]].sort());
    const bodies = await generateAssets(store, now, { projectId: project.id, count: 2 });
    await ok(tools, "select_reference", { characterId, slot: "body", assetId: bodies.assetIds[0] });

    const sheets = await generateAssets(store, now, { projectId: project.id, count: 2, target: { kind: "reference_sheet", characterId } });
    assert.equal(store.assets.getRequired(sheets.assetIds[0]).kind, "sheet");
    const sheet = await ok<{ link: { sheetAssetId: string }; archivedAssetIds: string[] }>(tools, "approve", {
      kind: "sheet",
      assetId: sheets.assetIds[0],
      projectId: project.id,
      characterId,
    });
    assert.equal(sheet.link.sheetAssetId, sheets.assetIds[0]);
    assert.deepEqual(sheet.archivedAssetIds, [sheets.assetIds[1]]);

    const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#235" } }).jpeg().toBuffer();
    const photo = await importImage(store, { projectId: null, name: "ridgeline.jpg", bytes: jpeg }, { now: now(), newId: randomUUID });
    const product = await ok<{ product: { allowedClaims: string[] }; link: { kind: string } }>(tools, "save_product", {
      projectId: project.id,
      product: {
        name: "Ridgeline 32 oz insulated bottle",
        link: "https://example.com/ridgeline",
        allowedClaims: ["Keeps drinks cold 24 hours", "Fits a car cup holder", "Dishwasher safe"],
        imageAssetIds: [photo.id],
      },
    });
    assert.equal(product.link.kind, "product");
    assert.equal(product.product.allowedClaims.length, 3);

    const script = await ok<{ script: { id: string; version: number } }>(tools, "save_script", {
      projectId: project.id,
      title: "Cup holder",
      beats: ridgelineBeats(),
    });
    const content = await ok<{ id: string; shots: { beatIndex: number }[] }>(tools, "plan_shots", {
      projectId: project.id,
      scriptId: script.script.id,
    });
    assert.equal(content.shots.length, 4);

    const stills = await generateAssets(store, now, {
      projectId: project.id,
      count: 2,
      target: { kind: "shot", contentId: content.id, beatIndex: 1, slot: "still" },
    });
    const approvedStill = await ok<{ archivedAssetIds: string[] }>(tools, "approve", {
      kind: "still",
      contentId: content.id,
      beatIndex: 1,
      assetId: stills.assetIds[0],
    });
    assert.deepEqual(approvedStill.archivedAssetIds, [stills.assetIds[1]]);
    const clips = await generateAssets(store, now, {
      projectId: project.id,
      kind: "video",
      target: { kind: "shot", contentId: content.id, beatIndex: 1, slot: "clip" },
    });
    await ok(tools, "approve", { kind: "clip", contentId: content.id, beatIndex: 1, assetId: clips.assetIds[0] });
    const missingBeat = await callTool(tools, "approve", { kind: "still", assetId: stills.assetIds[0] });
    assert.equal(!missingBeat.ok && missingBeat.failure.code, "invalid");

    const beats = ridgelineBeats();
    beats[0] = { ...beats[0], spokenLine: "This fits my cup holder, so I stopped buying bottled water." };
    const revised = await ok<{ change: { clipInvalidated: number[]; stillInvalidated: number[] }; updatedContentIds: string[] }>(
      tools,
      "save_script",
      { projectId: project.id, scriptId: script.script.id, baseVersion: 1, title: "Cup holder", beats },
    );
    assert.deepEqual(revised.change.clipInvalidated, [1]);
    assert.deepEqual(revised.change.stillInvalidated, []);
    assert.deepEqual(revised.updatedContentIds, [content.id]);
    const afterRevision = store.content.getRequired(content.id);
    assert.equal(afterRevision.shots[0].still.state, "approved");
    assert.equal(afterRevision.shots[0].clip.state, "open");
    const synced = await ok<{ scriptVersion: number }>(tools, "plan_shots", { projectId: project.id, scriptId: script.script.id, contentId: content.id });
    assert.equal(synced.scriptVersion, 2);

    const blocked = await callTool(tools, "archive_asset", { assetId: stills.assetIds[0] });
    assert.equal(!blocked.ok && blocked.failure.code, "conflict");
    const restored = await ok<{ state: { state: string } }>(tools, "archive_asset", { assetId: stills.assetIds[1], restore: true });
    assert.equal(restored.state.state, "active");
    const archived = await ok<{ state: { state: string; reason: string } }>(tools, "archive_asset", { assetId: stills.assetIds[1], reason: "Too dark" });
    assert.equal(archived.state.reason, "Too dark");

    const unconfirmed = await callTool(tools, "delete_asset_everywhere", { assetId: stills.assetIds[0] });
    assert.equal(!unconfirmed.ok && unconfirmed.failure.code, "invalid");
    const deleted = await ok<{ asset: { state: { state: string } }; usage: { kind: string }[] }>(tools, "delete_asset_everywhere", {
      assetId: stills.assetIds[0],
      confirm: true,
    });
    assert.equal(deleted.asset.state.state, "deleted");
    assert.ok(deleted.usage.some((entry) => entry.kind === "shot_approval"));
    assert.deepEqual(store.content.getRequired(content.id).shots[0].brokenAssetIds, [stills.assetIds[0]]);

    const listed = await ok<{ assets: { id: string }[] }>(tools, "list_assets", { projectId: project.id, state: "archived" });
    assert.ok(listed.assets.some((asset) => asset.id === stills.assetIds[1]));
    const videos = await ok<{ assets: unknown[] }>(tools, "list_assets", { projectId: project.id, kind: "video" });
    assert.equal(videos.assets.length, 1);

    const finalState = await ok<{ characters: { link: { sheetAssetId: string } }[]; products: unknown[]; scripts: unknown[]; contents: unknown[] }>(
      tools,
      "get_project_state",
      { projectId: project.id },
    );
    assert.equal(finalState.characters[0].link.sheetAssetId, sheets.assetIds[0]);
    assert.equal(finalState.products.length, 1);
    assert.equal(finalState.scripts.length, 1);
    assert.equal(finalState.contents.length, 1);
  });

  test("proposals, the approval gate, and the mock executor take a beat from still to clip to a rendered export", async () => {
    const { store, now, tools, project } = setup();
    const saved = await ok<{ character: { id: string } }>(tools, "save_character_bible", {
      projectId: project.id,
      wardrobe: "Oatmeal knit sweater and jeans",
      bible: averyBible(),
    });
    const characterId = saved.character.id;

    const faceProposal = await ok<{ recipeId: string; count: number; estimate: { kind: string }; target: { kind: string } }>(tools, "propose_candidates", {
      projectId: project.id,
      capability: "text_to_image",
      prompt: "Avery Lane, portrait, head turned about thirty degrees.",
      target: { kind: "character_reference", characterId, slot: "face" },
    });
    assert.equal(faceProposal.recipeId, "mock-text-to-image");
    assert.equal(faceProposal.count, 4);
    assert.equal(faceProposal.estimate.kind, "free");
    const faces = await ok<{ results: { outcome: string; assetIds: string[] }[] }>(tools, "submit_proposal", { proposal: faceProposal, wait: true });
    assert.deepEqual(faces.results.map((result) => result.outcome), ["completed", "completed", "completed", "completed"]);
    const again = await ok<{ results: { outcome: string }[] }>(tools, "submit_proposal", { proposal: faceProposal });
    assert.deepEqual(again.results.map((result) => result.outcome), ["existing", "existing", "existing", "existing"]);
    await ok(tools, "select_reference", { characterId, slot: "face", assetId: faces.results[0].assetIds[0] });

    const bodyProposal = await ok(tools, "propose_candidates", {
      projectId: project.id,
      capability: "image_edit",
      prompt: "Same person, full body, athleticwear.",
      referenceAssetIds: [faces.results[0].assetIds[0]],
      count: 1,
    });
    const body = await ok<{ results: { assetIds: string[] }[] }>(tools, "submit_proposal", { proposal: bodyProposal, wait: true });
    await ok(tools, "select_reference", { characterId, slot: "body", assetId: body.results[0].assetIds[0] });

    const sheetProposal = await ok<{ prompt: string; references: unknown[]; aspectRatio: string }>(tools, "generate_reference_sheet", {
      projectId: project.id,
      characterId,
    });
    assert.match(sheetProposal.prompt, /Wardrobe in every panel: Oatmeal knit sweater and jeans/);
    assert.equal(sheetProposal.references.length, 2);
    const sheets = await ok<{ results: { assetIds: string[] }[] }>(tools, "submit_proposal", { proposal: sheetProposal, wait: true });
    const sheetId = sheets.results[0].assetIds[0];
    assert.equal(store.assets.getRequired(sheetId).kind, "sheet");
    await ok(tools, "approve", { kind: "sheet", assetId: sheetId, projectId: project.id, characterId });

    const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#235" } }).jpeg().toBuffer();
    const photo = await importImage(store, { projectId: null, name: "ridgeline.jpg", bytes: jpeg }, { now: now(), newId: randomUUID });
    await ok(tools, "save_product", { projectId: project.id, product: { name: "Ridgeline 32 oz insulated bottle", imageAssetIds: [photo.id] } });
    const script = await ok<{ script: { id: string } }>(tools, "save_script", { projectId: project.id, title: "Cup holder", beats: ridgelineBeats().slice(0, 1) });
    const content = await ok<{ id: string }>(tools, "plan_shots", { projectId: project.id, scriptId: script.script.id });

    const stillProposal = await ok<{ prompt: string; references: { assetId: string }[]; capability: string; target: unknown }>(tools, "compose_still", {
      contentId: content.id,
      beatIndex: 1,
      count: 2,
    });
    assert.equal(stillProposal.capability, "image_edit");
    assert.deepEqual(stillProposal.references.map((reference) => reference.assetId), [sheetId, photo.id]);
    assert.match(stillProposal.prompt, /character reference sheet, reference image 1/);
    assert.match(stillProposal.prompt, /reference image 2 is the Ridgeline/);
    assert.deepEqual(stillProposal.target, { kind: "shot", contentId: content.id, beatIndex: 1, slot: "still" });
    const stills = await ok<{ results: { assetIds: string[] }[] }>(tools, "submit_proposal", { proposal: stillProposal, wait: true });
    const stillIds = stills.results.map((result) => result.assetIds[0]);
    const shot = store.content.getRequired(content.id).shots[0];
    assert.equal(shot.still.state, "open");
    assert.deepEqual(shot.still.state === "open" && shot.still.candidateIds, stillIds);

    const notYet = await callTool(tools, "generate_clip", { contentId: content.id, beatIndex: 1 });
    assert.equal(!notYet.ok && notYet.failure.code, "invalid");
    await ok(tools, "approve", { kind: "still", contentId: content.id, beatIndex: 1, assetId: stillIds[0] });

    const refined = await ok<{ target: unknown; references: unknown[] }>(tools, "refine_still", { assetId: stillIds[0], instruction: "Warmer morning light" });
    assert.deepEqual(refined.target, { kind: "shot", contentId: content.id, beatIndex: 1, slot: "still" });

    const clipProposal = await ok<{ prompt: string; capability: string; durationSeconds: number }>(tools, "generate_clip", { contentId: content.id, beatIndex: 1 });
    assert.equal(clipProposal.capability, "image_to_video");
    assert.equal(clipProposal.durationSeconds, 5);
    assert.match(clipProposal.prompt, /The person says, "I stopped buying bottled water the day this fit my cup holder\."/);
    const clips = await ok<{ results: { assetIds: string[] }[] }>(tools, "submit_proposal", { proposal: clipProposal, wait: true });
    const clipId = clips.results[0].assetIds[0];
    assert.equal(store.assets.getRequired(clipId).kind, "storyboard");
    await ok(tools, "approve", { kind: "clip", contentId: content.id, beatIndex: 1, assetId: clipId });

    const assembled = await ok<{
      export: { status: string; sources: { assetId: string }[]; options: { mute: boolean } };
      asset: { kind: string; width: number; height: number; video: { hasAudio: boolean } };
    }>(tools, "assemble_ad", { contentId: content.id, mute: true });
    assert.equal(assembled.export.status, "completed");
    assert.deepEqual(assembled.export.sources.map((source) => source.assetId), [clipId]);
    assert.equal(assembled.export.options.mute, true);
    assert.deepEqual([assembled.asset.kind, assembled.asset.width, assembled.asset.height], ["export", 1080, 1920]);
    assert.equal(assembled.asset.video.hasAudio, false);
    assert.equal(store.content.listExports(content.id).length, 1);
  });
});
