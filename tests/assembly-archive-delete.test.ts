import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterEach, describe, test } from "node:test";
import type { Asset } from "@/lib/domain/asset";
import type { ExportRecord } from "@/lib/domain/content";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import { openStore } from "@/server/store";
import { type ToolContext, callTool, createToolContext } from "@/server/tools";
import { approvedContent, beatsWith, importClip, importStill } from "./support/assembly-fixtures";
import { averyBible, clock, seedProject, tempStore } from "./support/domain-fixtures";

type Assembled = { export: ExportRecord; asset: Asset | null };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const project = seedProject(context.store, now);
  return { ...context, now, project, tools: createToolContext(context.store) };
}

async function ok<T>(tools: ToolContext, name: string, input: unknown): Promise<T> {
  const result = await callTool(tools, name, input);
  if (!result.ok) assert.fail(`${name} failed: ${result.failure.code} ${result.failure.message}`);
  return result.output as T;
}

async function failure(tools: ToolContext, name: string, input: unknown): Promise<{ code: string; message: string }> {
  const result = await callTool(tools, name, input);
  if (result.ok) assert.fail(`${name} should have failed`);
  return result.failure;
}

/** A one-beat ad with an approved clip, an unapproved second clip candidate, and a completed export. */
async function exportedAd(context: ReturnType<typeof setup>) {
  const { store, now, project, tools } = context;
  const clip = await importClip(store, project.id, { color: "red", width: 90, height: 160, rate: 24, seconds: 0.5, audio: true }, now());
  const spare = await importStill(store, project.id, "#204060", now());
  const content = await approvedContent(store, project.id, beatsWith(["Cold 24 hours."]), [clip], now);
  const assembled = await ok<Assembled>(tools, "assemble_ad", { contentId: content.id });
  assert.equal(assembled.export.status, "completed");
  return { clip, spare, content, record: assembled.export, output: assembled.asset! };
}

describe("archive and restore", () => {
  test("archives an unused asset without touching its file, restores it, and refuses approved ones", async () => {
    const context = setup();
    const { store, tools } = context;
    const { clip, spare } = await exportedAd(context);

    const archived = await ok<Asset>(tools, "archive_asset", { assetId: spare.id, reason: "Too dark" });
    assert.deepEqual(archived.state.state === "archived" && archived.state.reason, "Too dark");
    assert.ok(existsSync(resolveMediaPath(store.dataDir, spare.relativePath)));
    const listed = await ok<{ assets: Asset[] }>(tools, "list_assets", { state: "archived" });
    assert.deepEqual(listed.assets.map((asset) => asset.id), [spare.id]);
    assert.equal((await ok<Asset>(tools, "archive_asset", { assetId: spare.id })).revision, archived.revision, "archiving twice is a no-op");

    const restored = await ok<Asset>(tools, "archive_asset", { assetId: spare.id, restore: true });
    assert.equal(restored.state.state, "active");
    assert.equal(sha256(await readFile(resolveMediaPath(store.dataDir, spare.relativePath))), spare.sha256);

    const refused = await failure(tools, "archive_asset", { assetId: clip.id });
    assert.equal(refused.code, "conflict");
    assert.equal(store.assets.getRequired(clip.id).state.state, "active");
  });
});

describe("delete everywhere", () => {
  test("needs explicit confirmation", async () => {
    const context = setup();
    const { spare } = await exportedAd(context);
    assert.equal((await failure(context.tools, "delete_asset_everywhere", { assetId: spare.id })).code, "invalid");
    assert.equal(context.store.assets.getRequired(spare.id).state.state, "active");
  });

  test("an unused asset is removed with its file and cannot be restored", async () => {
    const context = setup();
    const { store, tools } = context;
    const { spare } = await exportedAd(context);
    const result = await ok<{ asset: Asset; usage: unknown[] }>(tools, "delete_asset_everywhere", { assetId: spare.id, confirm: true });
    assert.equal(result.asset.state.state, "deleted");
    assert.deepEqual(result.usage, []);
    assert.equal(existsSync(resolveMediaPath(store.dataDir, spare.relativePath)), false);
    assert.equal((await failure(tools, "archive_asset", { assetId: spare.id, restore: true })).code, "not_found");
    assert.equal((await failure(tools, "archive_asset", { assetId: spare.id })).code, "not_found");
  });

  test("refuses a clip an export depends on unless forced, then breaks every reference cleanly", async () => {
    const context = setup();
    const { store, tools, dir } = context;
    const { clip, content, record, output } = await exportedAd(context);
    const clipPath = resolveMediaPath(store.dataDir, clip.relativePath);

    const refused = await failure(tools, "delete_asset_everywhere", { assetId: clip.id, confirm: true });
    assert.equal(refused.code, "conflict");
    assert.match(refused.message, /export depends on this asset/);
    assert.ok(existsSync(clipPath));
    assert.equal(store.assets.getRequired(clip.id).state.state, "active");
    assert.deepEqual(store.content.getExport(record.id)!.brokenAssetIds, []);
    assert.equal(store.content.getRequired(content.id).shots[0].clip.state, "approved");

    const forced = await ok<{ asset: Asset; usage: { kind: string }[] }>(tools, "delete_asset_everywhere", { assetId: clip.id, confirm: true, force: true });
    assert.equal(forced.asset.state.state, "deleted");
    assert.deepEqual(forced.usage.map((entry) => entry.kind).sort(), ["export_source", "shot_approval"]);
    assert.equal(existsSync(clipPath), false);
    const shot = store.content.getRequired(content.id).shots[0];
    assert.deepEqual(shot.clip, { state: "empty" });
    assert.deepEqual(shot.brokenAssetIds, [clip.id]);
    assert.equal(shot.still.state, "approved", "the still is untouched");
    const broken = store.content.getExport(record.id)!;
    assert.deepEqual(broken.brokenAssetIds, [clip.id]);
    assert.deepEqual({ ...broken, brokenAssetIds: [] }, record, "the export record is otherwise unchanged");
    assert.equal(sha256(await readFile(resolveMediaPath(store.dataDir, output.relativePath))), output.sha256, "the rendered ad survives");

    const again = await failure(tools, "assemble_ad", { contentId: content.id });
    assert.equal(again.code, "invalid");
    assert.match(again.message, /^Beat 1 has no approved clip/);

    store.close();
    const reopened = openStore(dir);
    try {
      assert.equal(reopened.assets.getRequired(clip.id).state.state, "deleted");
      assert.deepEqual(reopened.content.getExport(record.id)!.brokenAssetIds, [clip.id]);
      assert.deepEqual(reopened.content.getRequired(content.id).shots[0].brokenAssetIds, [clip.id]);
    } finally {
      reopened.close();
    }
  });

  test("deleting the rendered ad itself is refused unless forced and removes the MP4 and poster", async () => {
    const context = setup();
    const { store, tools } = context;
    const { record, output } = await exportedAd(context);
    const mp4 = resolveMediaPath(store.dataDir, output.relativePath);
    const poster = resolveMediaPath(store.dataDir, output.video!.posterPath!);
    assert.ok(existsSync(mp4) && existsSync(poster));
    assert.equal((await failure(tools, "delete_asset_everywhere", { assetId: output.id, confirm: true })).code, "conflict");
    assert.ok(existsSync(mp4));
    const forced = await ok<{ usage: { kind: string }[] }>(tools, "delete_asset_everywhere", { assetId: output.id, confirm: true, force: true });
    assert.deepEqual(forced.usage.map((entry) => entry.kind), ["export_output"]);
    assert.equal(existsSync(mp4), false);
    assert.equal(existsSync(poster), false);
    assert.deepEqual(store.content.getExport(record.id)!.brokenAssetIds, [output.id]);
  });

  test("deleting a locked face clears the character reference and marks the character broken", async () => {
    const context = setup();
    const { store, now, project, tools } = context;
    const saved = await ok<{ character: { id: string } }>(tools, "save_character_bible", { projectId: project.id, bible: averyBible() });
    const face = await importStill(store, project.id, "#c08060", now());
    await ok(tools, "select_reference", { characterId: saved.character.id, slot: "face", assetId: face.id });
    assert.equal((await failure(tools, "archive_asset", { assetId: face.id })).code, "conflict");
    const result = await ok<{ usage: { kind: string }[] }>(tools, "delete_asset_everywhere", { assetId: face.id, confirm: true });
    assert.deepEqual(result.usage.map((entry) => entry.kind), ["character_reference"]);
    const character = store.library.getRequired(saved.character.id);
    assert.equal(character.kind === "character" && character.bible.references.faceAssetId, null);
    assert.deepEqual(character.brokenAssetIds, [face.id]);
    assert.equal(existsSync(resolveMediaPath(store.dataDir, face.relativePath)), false);
  });
});
