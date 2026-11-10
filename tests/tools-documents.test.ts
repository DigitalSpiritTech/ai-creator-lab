/**
 * Artifact panel documents (F1): every save of the brief, bible, product card, and script keeps a
 * version; a restore saves an earlier one as the newest; the assistant and later steps read the
 * restored document. Includes the PRD acceptance checks.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import type { DocumentVersion } from "@creator-lab/core/domain/document";
import type { GenerationProposal } from "@creator-lab/core/domain/job";
import { createCharacter, createProduct } from "@creator-lab/core/domain/library";
import { createProject, saveBrief } from "@creator-lab/core/domain/project";
import { loadSnapshot, renderSnapshot } from "@/server/agent/state";
import { DATABASE_FILE, openStore } from "@/server/store";
import { MIGRATIONS } from "@/server/store/migrations";
import { type ToolContext, callTool, createGenerationContext } from "@/server/tools";
import { averyBible, clock, generateAssets, ridgelineBeats, ridgelineProduct, seedProject, tempDir, tempStore } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../packages/recipes/workflows", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const BRIEF = { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters who drive to work", platforms: ["TikTok"], tone: "Warm, direct" };

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const generation = createGenerationContext(context.store, { workflowsDir });
  const user: ToolContext = { store: context.store, now, newId: randomUUID, generation, author: "user" };
  const assistant: ToolContext = { ...user, author: "assistant" };
  return { ...context, now, user, assistant, project: seedProject(context.store, now) };
}

async function ok<T>(tools: ToolContext, name: string, input: unknown): Promise<T> {
  const result = await callTool(tools, name, input);
  if (!result.ok) assert.fail(`${name} failed: ${result.failure.code} ${result.failure.message}`);
  return result.output as T;
}

type Listing = { current: number | null; versions: DocumentVersion[] };

describe("document versions", () => {
  test("each brief save keeps a version with its author; an unchanged save records nothing", async () => {
    const { user, assistant, project } = setup();
    await ok(assistant, "save_brief", { projectId: project.id, brief: BRIEF });
    await ok(user, "save_brief", { projectId: project.id, brief: { ...BRIEF, tone: "Calm, no hype" } });
    await ok(user, "save_brief", { projectId: project.id, brief: { ...BRIEF, tone: "Calm, no hype" } });
    const listing = await ok<Listing>(user, "list_document_versions", { kind: "brief", subjectId: project.id });
    assert.deepEqual(listing.versions.map((version) => [version.version, version.author, version.restoredFrom]), [[1, "assistant", null], [2, "user", null]]);
    assert.equal(listing.current, 2);
  });

  test("restoring a brief saves it as the newest version and the assistant's state shows it", async () => {
    const { store, user, project } = setup();
    await ok(user, "save_brief", { projectId: project.id, brief: BRIEF });
    await ok(user, "save_brief", { projectId: project.id, brief: { ...BRIEF, audience: "Gym regulars" } });
    const restored = await ok<{ document: DocumentVersion; restoredFrom: number }>(user, "restore_document_version", { kind: "brief", subjectId: project.id, version: 1 });
    assert.deepEqual([restored.document.version, restored.document.restoredFrom], [3, 1]);
    assert.equal(store.projects.getRequired(project.id).brief?.audience, BRIEF.audience);
    assert.match(renderSnapshot(loadSnapshot(store, project.id)!), /audience Commuters who drive to work/);
    const again = await ok<Listing>(user, "list_document_versions", { kind: "brief", subjectId: project.id });
    assert.equal(again.versions.length, 3, "nothing is deleted");
  });

  test("acceptance: a brief edited in the panel is what the assistant reads when it rewrites the script", async () => {
    const { store, user, assistant, project } = setup();
    await ok(assistant, "save_brief", { projectId: project.id, brief: BRIEF });
    const script = await ok<{ script: { id: string } }>(assistant, "save_script", { projectId: project.id, title: "First ad", beats: ridgelineBeats() });
    const edited = { ...BRIEF, audience: "Night-shift nurses" };
    await ok(user, "save_brief", { projectId: project.id, brief: edited, revision: store.projects.getRequired(project.id).revision });
    const state = renderSnapshot(loadSnapshot(store, project.id)!);
    assert.match(state, /audience Night-shift nurses/, "the system prompt state carries the edit");
    const projectState = await ok<{ project: { brief: typeof BRIEF } }>(assistant, "get_project_state", { projectId: project.id });
    assert.equal(projectState.project.brief.audience, "Night-shift nurses");
    const revised = await ok<{ script: { version: number } }>(assistant, "save_script", { projectId: project.id, scriptId: script.script.id, title: "Night shift ad", beats: ridgelineBeats() });
    assert.equal(revised.script.version, 2);
  });

  test("acceptance: restoring an earlier bible changes the next still's prompt and keeps the locked face", async () => {
    const { store, user, assistant, now, project } = setup();
    const saved = await ok<{ character: { id: string; revision: number } }>(assistant, "save_character_bible", { projectId: project.id, wardrobe: "Navy crew-neck tee", bible: averyBible() });
    const characterId = saved.character.id;
    const face = await generateAssets(store, now, { projectId: project.id, target: { kind: "character_reference", characterId, slot: "face" } });
    await ok(user, "select_reference", { characterId, slot: "face", assetId: face.assetIds[0] });
    const changed = { ...averyBible(), visualCore: "Avery Lane, early 30s, short platinum bob, round glasses, light freckles, warm and direct." };
    const current = store.library.getRequired(characterId);
    await ok(user, "save_character_bible", { characterId, revision: current.revision, bible: changed });

    const script = await ok<{ script: { id: string; beats: { index: number; type: string }[] } }>(user, "save_script", { projectId: project.id, title: "First ad", beats: ridgelineBeats() });
    const content = await ok<{ id: string }>(user, "plan_shots", { projectId: project.id, scriptId: script.script.id });
    const talking = script.script.beats.find((beat) => beat.type === "talking")!.index;
    const before = await ok<GenerationProposal>(user, "compose_still", { contentId: content.id, beatIndex: talking, count: 1 });
    assert.match(before.prompt, /platinum bob/);

    const listing = await ok<Listing>(user, "list_document_versions", { kind: "bible", subjectId: characterId });
    assert.deepEqual(listing.versions.map((version) => version.author), ["assistant", "user"], "locking the face is not a bible edit");
    await ok(user, "restore_document_version", { kind: "bible", subjectId: characterId, version: 1 });
    const after = await ok<GenerationProposal>(user, "compose_still", { contentId: content.id, beatIndex: talking, count: 1 });
    assert.match(after.prompt, new RegExp(averyBible().visualCore.slice(0, 40)));
    assert.doesNotMatch(after.prompt, /platinum bob/);
    const item = store.library.getRequired(characterId);
    assert.ok(item.kind === "character" && item.bible.references.faceAssetId === face.assetIds[0], "the locked face is kept");
  });

  test("restoring a product card keeps only photos that are still active", async () => {
    const { store, user, now, project } = setup();
    const photos = await generateAssets(store, now, { projectId: project.id, count: 2 });
    const created = await ok<{ product: { id: string; revision: number } }>(user, "save_product", { projectId: project.id, product: ridgelineProduct(photos.assetIds) });
    await ok(user, "save_product", { productId: created.product.id, product: { ...ridgelineProduct([]), allowedClaims: ["fits a car cup holder"] } });
    await ok(user, "archive_asset", { assetId: photos.assetIds[1] });
    const restored = await ok<{ skippedAssetIds: string[] }>(user, "restore_document_version", { kind: "product", subjectId: created.product.id, version: 1 });
    assert.deepEqual(restored.skippedAssetIds, [photos.assetIds[1]]);
    const item = store.library.getRequired(created.product.id);
    assert.ok(item.kind === "product");
    assert.deepEqual(item.imageAssetIds, [photos.assetIds[0]]);
    assert.deepEqual(item.allowedClaims, ridgelineProduct().allowedClaims);
  });

  test("deleting a product photo everywhere records the changed card as a version", async () => {
    const { store, user, now, project } = setup();
    const photos = await generateAssets(store, now, { projectId: project.id, count: 2 });
    const created = await ok<{ product: { id: string } }>(user, "save_product", { projectId: project.id, product: ridgelineProduct(photos.assetIds) });
    await ok(user, "delete_asset_everywhere", { assetId: photos.assetIds[0], confirm: true });
    const listing = await ok<Listing>(user, "list_document_versions", { kind: "product", subjectId: created.product.id });
    assert.equal(listing.versions.length, 2);
    assert.equal(listing.current, 2, "the newest version matches the live card");
    const newest = listing.versions.at(-1)!;
    assert.ok(newest.kind === "product");
    assert.deepEqual(newest.content.imageAssetIds, [photos.assetIds[1]]);
  });

  test("restoring the version that is already current is refused and writes nothing", async () => {
    const { user, assistant, project } = setup();
    await ok(user, "save_brief", { projectId: project.id, brief: BRIEF });
    const result = await callTool(assistant, "restore_document_version", { kind: "brief", subjectId: project.id, version: 1 });
    assert.ok(!result.ok && result.failure.code === "invalid");
    const listing = await ok<Listing>(user, "list_document_versions", { kind: "brief", subjectId: project.id });
    assert.equal(listing.versions.length, 1);
  });

  test("restoring a script saves it as a new version and withdraws approvals the way an edit would", async () => {
    const { user, project } = setup();
    const beats = ridgelineBeats();
    const first = await ok<{ script: { id: string } }>(user, "save_script", { projectId: project.id, title: "First ad", beats });
    const content = await ok<{ id: string; scriptVersion: number }>(user, "plan_shots", { projectId: project.id, scriptId: first.script.id });
    const edited = beats.map((beat, index) => (index === 0 ? { ...beat, visual: "Avery Lane in a car, bottle in the cup holder" } : beat));
    await ok(user, "save_script", { projectId: project.id, scriptId: first.script.id, title: "First ad", beats: edited });
    await ok(user, "plan_shots", { projectId: project.id, scriptId: first.script.id, contentId: content.id });
    const restored = await ok<{ document: DocumentVersion; change: { stillInvalidated: number[] }; updatedContentIds: string[] }>(user, "restore_document_version", {
      kind: "script",
      subjectId: first.script.id,
      version: 1,
    });
    assert.equal(restored.document.version, 3);
    assert.ok(restored.document.kind === "script" && restored.document.content.beats[0].visual === beats[0].visual);
    assert.deepEqual(restored.change.stillInvalidated, [1]);
    assert.deepEqual(restored.updatedContentIds, [content.id]);
    const listing = await ok<Listing>(user, "list_document_versions", { kind: "script", subjectId: first.script.id });
    assert.deepEqual([listing.current, listing.versions.length], [3, 3]);
  });

  test("a version that does not exist, or the wrong kind of Library item, is refused", async () => {
    const { user, project } = setup();
    await ok(user, "save_brief", { projectId: project.id, brief: BRIEF });
    const missing = await callTool(user, "restore_document_version", { kind: "brief", subjectId: project.id, version: 9 });
    assert.ok(!missing.ok && missing.failure.code === "not_found");
    const product = await ok<{ product: { id: string } }>(user, "save_product", { product: ridgelineProduct() });
    const wrong = await callTool(user, "list_document_versions", { kind: "bible", subjectId: product.product.id });
    assert.ok(!wrong.ok && wrong.failure.code === "invalid");
  });

  test("migration 3 starts existing briefs, bibles, and product cards at version 1", () => {
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const raw = new DatabaseSync(join(dir, DATABASE_FILE));
    raw.exec(MIGRATIONS[0]);
    raw.exec(MIGRATIONS[1]);
    raw.exec("PRAGMA user_version = 2");
    const time = 1_760_000_000_000;
    const project = saveBrief(createProject({ name: "Bottle launch" }, randomUUID(), time), BRIEF, time + 1);
    const bare = createProject({ name: "No brief yet" }, randomUUID(), time);
    const character = createCharacter(randomUUID(), averyBible(), time);
    const product = createProduct(randomUUID(), ridgelineProduct(), time);
    raw.prepare("INSERT INTO projects(id, data) VALUES (?, ?)").run(project.id, JSON.stringify(project));
    raw.prepare("INSERT INTO projects(id, data) VALUES (?, ?)").run(bare.id, JSON.stringify(bare));
    for (const item of [character, product]) raw.prepare("INSERT INTO library_items(id, kind, data) VALUES (?, ?, ?)").run(item.id, item.kind, JSON.stringify(item));
    raw.close();

    const store = openStore(dir);
    try {
      const [brief] = store.documents.list("brief", project.id);
      assert.deepEqual([brief.version, brief.author, brief.createdAt], [1, null, time + 1]);
      assert.deepEqual(brief.content, BRIEF);
      assert.equal(store.documents.list("brief", bare.id).length, 0);
      const [bible] = store.documents.list("bible", character.id);
      assert.ok(bible.kind === "bible");
      assert.equal(bible.content.visualCore, averyBible().visualCore);
      assert.equal("references" in bible.content, false);
      const [card] = store.documents.list("product", product.id);
      assert.ok(card.kind === "product");
      assert.deepEqual(card.content.allowedClaims, ridgelineProduct().allowedClaims);
    } finally {
      store.close();
    }
  });
});
