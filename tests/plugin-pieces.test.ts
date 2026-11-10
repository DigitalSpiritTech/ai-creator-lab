/**
 * Plugin content pieces (F8 phase B): the pure slot transitions, the registry's tool, piece, and
 * assistant contributions, the store and migration 8, generations landing in a piece slot, the
 * `approve` kind `slot`, the Archive and delete-everywhere rules, piece bodies in the document
 * history, and the port a plugin tool runs against. Runs in its own process, so the throwaway
 * "memo" plugin registered into the server registry here never reaches other tests.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { z } from "zod";
import { toFailure } from "@creator-lab/core/domain/failure";
import {
  type PluginPiece,
  addPieceCandidates,
  approvePieceCandidate,
  approvedSlots,
  createPiece,
  revisePiece,
  selectPieceCandidate,
  withdrawPieceApproval,
} from "@creator-lab/core/domain/piece";
import { blockingArchiveUsage, findAssetUsage, planDeleteEverywhere } from "@creator-lab/core/domain/usage";
import { type PluginDefinition, createPluginRegistry, definePluginTool, toolPrefix } from "@creator-lab/core/registry";
import { serverPlugins } from "@/plugins/server";
import { DATABASE_FILE, openStore } from "@/server/store";
import { MIGRATIONS } from "@/server/store/migrations";
import { type ToolContext, callTool, createGenerationContext } from "@/server/tools";
import { pluginPort } from "@/server/tools/plugins";
import { insertPiece } from "@/server/tools/pieces";
import { clock, generateAssets, ridgelineProduct, seedProject, tempDir, tempStore } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../packages/recipes/workflows", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const failure = (code: string, pattern: RegExp) => (error: unknown) => toFailure(error).code === code && pattern.test(toFailure(error).message);

const MemoBodySchema = z.object({ text: z.string().trim().min(1).max(200) }).strict();
const memoPlugin: PluginDefinition = {
  id: "memo-pad",
  label: "Memo pad",
  contentTypes: [{ id: "memo", label: "Memo", app: { id: "memo-maker", label: "Memo Maker" }, description: "A memo with a picture.", pieceType: "memo", defaultPanel: "memo-pad.edit" }],
  panels: [{ id: "memo-pad.edit", contentType: "memo", title: "Edit" }],
  pieces: [{ pieceType: "memo", body: MemoBodySchema }],
};
serverPlugins.registerPlugin(memoPlugin);

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const tools: ToolContext = { store: context.store, now, newId: randomUUID, generation: createGenerationContext(context.store, { workflowsDir }) };
  const project = seedProject(context.store, now);
  return { ...context, now, tools, project };
}

function memo(projectId: string, now: number, slots = ["cover", "4:5"]): PluginPiece {
  return createPiece({ id: randomUUID(), projectId, type: "memo", title: "Morning memo", slots, body: { text: "Cold by noon." } }, now);
}

describe("piece transitions", () => {
  test("slots start empty; candidates, selection, approval, and withdrawal follow the shot rules", () => {
    const projectId = randomUUID();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    let piece = memo(projectId, 1);
    assert.deepEqual(Object.keys(piece.slots), ["cover", "4:5"]);
    assert.ok(Object.values(piece.slots).every((slot) => slot.state === "empty"));
    assert.equal(piece.ownerId, "local");

    piece = addPieceCandidates(piece, "4:5", [a, b], 2);
    assert.deepEqual(piece.slots["4:5"], { state: "open", candidateIds: [a, b], selectedId: null });
    assert.equal(addPieceCandidates(piece, "4:5", [a], 3), piece, "adding a known candidate changes nothing");
    piece = selectPieceCandidate(piece, "4:5", b, 3);
    assert.equal(piece.slots["4:5"].state === "open" && piece.slots["4:5"].selectedId, b);

    const approved = approvePieceCandidate(piece, "4:5", a, 4);
    assert.deepEqual(approved.siblingIds, [b]);
    piece = approved.piece;
    assert.equal(piece.slots["4:5"].state, "approved");
    assert.equal(approvePieceCandidate(piece, "4:5", a, 5).piece, piece, "approving the approved one again is a no-op");
    assert.throws(() => selectPieceCandidate(piece, "4:5", b, 5), failure("conflict", /already has an approved choice/));
    piece = addPieceCandidates(piece, "4:5", [c], 6);
    assert.equal(piece.slots["4:5"].state, "approved", "a new candidate keeps the approval");
    assert.deepEqual(approvedSlots(piece), [{ slot: "4:5", assetId: a }]);

    piece = withdrawPieceApproval(piece, "4:5", 7);
    assert.deepEqual(piece.slots["4:5"], { state: "open", candidateIds: [a, b, c], selectedId: null });
    assert.deepEqual(approvedSlots(piece), []);

    assert.throws(() => addPieceCandidates(piece, "9:16", [a], 8), failure("not_found", /no 9:16 slot/));
    assert.throws(() => approvePieceCandidate(piece, "cover", a, 8), failure("invalid", /Choose one of the cover candidates/));
    assert.throws(() => createPiece({ id: randomUUID(), projectId, type: "memo", title: "Twice", slots: ["cover", "cover"], body: {} }, 1), failure("invalid", /each slot once/));
  });

  test("revisePiece bumps the revision only for a real change", () => {
    const piece = memo(randomUUID(), 1);
    assert.equal(revisePiece(piece, { body: { text: "Cold by noon." } }, 2), piece);
    const next = revisePiece(piece, { body: { text: "Still cold at five." }, title: "Evening memo" }, 3);
    assert.equal(next.revision, 1);
    assert.equal(next.title, "Evening memo");
  });

  test("usage: an approved slot blocks archiving; delete everywhere drops it and marks the piece broken", () => {
    const [a, b] = [randomUUID(), randomUUID()];
    let piece = addPieceCandidates(memo(randomUUID(), 1), "4:5", [a, b], 2);
    piece = approvePieceCandidate(piece, "4:5", a, 3).piece;
    const graph = { libraryItems: [], links: [], contents: [], exports: [], assets: [], pieces: [piece] };
    assert.deepEqual(findAssetUsage(graph, a), [{ kind: "piece_approval", contentId: piece.id, slot: "4:5" }]);
    assert.deepEqual(findAssetUsage(graph, b), [{ kind: "piece_candidate", contentId: piece.id, slot: "4:5" }]);
    assert.equal(blockingArchiveUsage(findAssetUsage(graph, a)).length, 1);
    assert.equal(blockingArchiveUsage(findAssetUsage(graph, b)).length, 0);
    const asset = {
      id: a, ownerId: "local", projectId: piece.projectId, kind: "image" as const, mime: "image/png" as const, relativePath: `media/${a}.png`, width: 1080, height: 1350,
      sha256: "0".repeat(64), provenance: { source: "upload" as const, name: "still.png", originalSha256: "0".repeat(64) }, state: { state: "active" as const }, revision: 0, createdAt: 1,
    };
    const plan = planDeleteEverywhere(graph, asset, { force: false, now: 9 });
    assert.equal(plan.pieces.length, 1);
    assert.deepEqual(plan.pieces[0].slots["4:5"], { state: "open", candidateIds: [b], selectedId: null });
    assert.deepEqual(plan.pieces[0].brokenAssetIds, [a]);
  });
});

describe("registry contributions", () => {
  const base = (extra: Partial<PluginDefinition>): PluginDefinition => ({ ...memoPlugin, id: "memo-pad", ...extra });
  const tool = (name: string, contentType = "memo") =>
    definePluginTool({ name, contentType, description: "Saves a memo.", input: z.object({ text: z.string() }).strict(), output: z.object({ ok: z.boolean() }), run: () => ({ ok: true }) });

  test("plugin tools are prefixed with the plugin id, belong to its own content types, and are unique", () => {
    assert.equal(toolPrefix("memo-pad"), "memo_pad_");
    const registry = createPluginRegistry();
    registry.registerPlugin(base({ tools: [tool("memo_pad_save")], assistants: [{ contentType: "memo", systemPrompt: "You write memos.", stage: () => ({ stepId: "write", guidance: "Write.", state: [] }) }] }));
    assert.deepEqual(registry.tools().map((entry) => [entry.name, entry.plugin]), [["memo_pad_save", "memo-pad"]]);
    assert.deepEqual(registry.tools("memo").length, 1);
    assert.deepEqual(registry.tools("ad"), []);
    assert.equal(registry.pieceType("memo")?.plugin, "memo-pad");
    assert.equal(registry.assistant("memo")?.systemPrompt, "You write memos.");

    const fresh = () => createPluginRegistry();
    assert.throws(() => fresh().registerPlugin(base({ tools: [tool("save_brief")] })), /must be named memo_pad_<action>/);
    assert.throws(() => fresh().registerPlugin(base({ tools: [tool("memo_pad_")] })), /must be named memo_pad_<action>/);
    assert.throws(() => fresh().registerPlugin(base({ tools: [tool("memo_pad_save", "ad")] })), /does not register/);
    assert.throws(() => fresh().registerPlugin(base({ tools: [tool("memo_pad_save"), tool("memo_pad_save")] })), /registered twice/);
    assert.throws(() => fresh().registerPlugin(base({ pieces: [{ pieceType: "ad", body: MemoBodySchema }] })), /not the piece type/);
    assert.throws(() => fresh().registerPlugin(base({ assistants: [{ contentType: "memo", systemPrompt: " ", stage: () => ({ stepId: "x", guidance: "", state: [] }) }] })), /needs a system prompt/);
    assert.throws(() => fresh().registerPlugin(base({ assistants: [{ contentType: "ad", systemPrompt: "x", stage: () => ({ stepId: "x", guidance: "", state: [] }) }] })), /one of this plugin's content types/);
  });
});

describe("stored pieces", () => {
  test("a generation aimed at a piece slot lands there; approve kind slot archives the rest; approved slots cannot be archived", async () => {
    const { store, now, tools, project } = setup();
    const piece = insertPiece(tools, memo(project.id, now()));
    assert.equal(store.documents.latest("piece", piece.id)?.version, 1, "the body is version 1 of its document");
    const target = { kind: "piece" as const, contentId: piece.id, slot: "4:5" };
    const first = await generateAssets(store, now, { projectId: project.id, target });
    const second = await generateAssets(store, now, { projectId: project.id, target });
    const stored = store.pieces.getRequired(piece.id);
    assert.deepEqual(stored.slots["4:5"], { state: "open", candidateIds: [first.assetIds[0], second.assetIds[0]], selectedId: null });

    const approved = await callTool(tools, "approve", { kind: "slot", contentId: piece.id, slot: "4:5", assetId: first.assetIds[0] });
    assert.ok(approved.ok, JSON.stringify(approved));
    const output = approved.output as { piece: PluginPiece; archivedAssetIds: string[] };
    assert.equal(output.piece.slots["4:5"].state, "approved");
    assert.deepEqual(output.archivedAssetIds, [second.assetIds[0]]);
    assert.equal(store.assets.getRequired(second.assetIds[0]).state.state, "archived");

    const archive = await callTool(tools, "archive_asset", { assetId: first.assetIds[0] });
    assert.equal(archive.ok, false);
    const missingSlot = await callTool(tools, "approve", { kind: "slot", contentId: piece.id, assetId: first.assetIds[0] });
    assert.equal(missingSlot.ok, false, "kind slot needs the slot key");

    const state = await callTool(tools, "get_project_state", { projectId: project.id });
    assert.ok(state.ok);
    assert.deepEqual((state.output as { pieces: { id: string }[] }).pieces.map((entry) => entry.id), [piece.id]);

    const deleted = await callTool(tools, "delete_asset_everywhere", { assetId: first.assetIds[0], confirm: true });
    assert.ok(deleted.ok);
    const after = store.pieces.getRequired(piece.id);
    assert.equal(after.slots["4:5"].state, "open");
    assert.deepEqual(after.brokenAssetIds, [first.assetIds[0]]);
  });

  test("propose_candidates refuses a piece target that is not in the project or has no such slot", async () => {
    const { now, tools, project } = setup();
    const piece = insertPiece(tools, memo(project.id, now()));
    const propose = (target: unknown, projectId = project.id) =>
      callTool(tools, "propose_candidates", { projectId, capability: "text_to_image", recipeId: "mock-text-to-image", prompt: "A dark green bottle", count: 1, target });
    const good = await propose({ kind: "piece", contentId: piece.id, slot: "4:5" });
    assert.ok(good.ok);
    const noSlot = await propose({ kind: "piece", contentId: piece.id, slot: "16:9" });
    assert.ok(!noSlot.ok && /no 16:9 slot\. Its slots: cover, 4:5/.test(noSlot.failure.message));
    const other = seedProject(tools.store, now, "Another project");
    const elsewhere = await propose({ kind: "piece", contentId: piece.id, slot: "4:5" }, other.id);
    assert.ok(!elsewhere.ok && elsewhere.failure.code === "not_found");
  });

  test("a piece body is a document: list its versions and restore one, checked by the plugin's schema", async () => {
    const { store, now, tools, project } = setup();
    const piece = insertPiece(tools, memo(project.id, now()));
    const port = pluginPort(tools, new Set(["memo"]), callTool);
    port.savePiece(revisePiece(piece, { body: { text: "Still cold at five." } }, now()));
    assert.throws(() => port.savePiece(revisePiece(store.pieces.getRequired(piece.id), { body: { text: "" } }, now())), failure("invalid", /text/));
    const listed = await callTool(tools, "list_document_versions", { kind: "piece", subjectId: piece.id });
    assert.ok(listed.ok);
    const history = listed.output as { current: number; versions: { version: number; content: { text: string } }[] };
    assert.deepEqual(history.versions.map((version) => version.content.text), ["Cold by noon.", "Still cold at five."]);
    assert.equal(history.current, 2);
    const restored = await callTool(tools, "restore_document_version", { kind: "piece", subjectId: piece.id, version: 1 });
    assert.ok(restored.ok, JSON.stringify(restored));
    assert.equal((restored.output as { document: { version: number; restoredFrom: number } }).document.restoredFrom, 1);
    assert.deepEqual(store.pieces.getRequired(piece.id).body, { text: "Cold by noon." });
  });

  test("the port scopes a plugin to its own piece types and owner, and never reaches the gate or deletion", async () => {
    const { store, now, tools, project } = setup();
    const piece = insertPiece(tools, memo(project.id, now()));
    const port = pluginPort(tools, new Set(["memo"]), callTool);
    assert.equal(port.piece(piece.id).id, piece.id);
    assert.deepEqual(port.pieces(project.id, "memo").map((entry) => entry.id), [piece.id]);
    assert.throws(() => pluginPort(tools, new Set(["jingle"]), callTool).piece(piece.id), failure("not_found", /could not be found/));
    assert.throws(() => pluginPort({ ...tools, ownerId: "team-a" }, new Set(["memo"]), callTool).piece(piece.id), failure("not_found", /could not be found/));
    assert.throws(() => pluginPort({ ...tools, ownerId: "team-a" }, new Set(["memo"]), callTool).project(project.id), failure("not_found", /project could not be found/));
    assert.throws(() => port.pieces(project.id, "jingle"), failure("invalid", /does not keep jingle/));
    assert.throws(() => port.createPiece({ ...memo(project.id, now()), type: "jingle" }), failure("not_found", /could not be found/));
    for (const refused of ["submit_proposal", "delete_asset_everywhere"]) {
      await assert.rejects(port.callTool(refused, {}), failure("invalid", /cannot call/));
    }
    const state = await port.callTool<{ project: { id: string } }>("get_project_state", { projectId: project.id });
    assert.equal(state.project.id, project.id);
    await assert.rejects(port.callTool("get_project_state", { projectId: randomUUID() }), failure("not_found", /project/));
    assert.equal(store.pieces.listByProject(project.id).length, 1);
  });

  test("unlinking a Library item is refused while an approved slot was made from its images", async () => {
    const { store, now, tools, project } = setup();
    const product = await callTool(tools, "save_product", { product: ridgelineProduct(), projectId: project.id });
    assert.ok(product.ok);
    const productId = (product.output as { product: { id: string } }).product.id;
    const photo = await generateAssets(store, now, { projectId: project.id, target: { kind: "product_image", productId } });
    const approvedPhoto = await callTool(tools, "save_product", { productId, product: ridgelineProduct(photo.assetIds) });
    assert.ok(approvedPhoto.ok, JSON.stringify(approvedPhoto));
    const piece = insertPiece(tools, memo(project.id, now()));
    const asset = store.assets.getRequired(photo.assetIds[0]);
    const made = await generateAssets(store, now, { projectId: project.id, target: { kind: "piece", contentId: piece.id, slot: "cover" }, inputs: [{ role: "image1", assetId: asset.id, sha256: asset.sha256 }] });
    assert.ok((await callTool(tools, "approve", { kind: "slot", contentId: piece.id, slot: "cover", assetId: made.assetIds[0] })).ok);
    const unlink = await callTool(tools, "unlink_library_item", { projectId: project.id, itemId: productId });
    assert.ok(!unlink.ok && /approved cover in "Morning memo"/.test(unlink.failure.message));
  });
});

describe("migration 8", () => {
  test("a version 7 database keeps its document history and gains plugin pieces and the piece kind", () => {
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const raw = new DatabaseSync(join(dir, DATABASE_FILE));
    for (const [index, sql] of MIGRATIONS.slice(0, 7).entries()) {
      raw.exec(sql);
      raw.exec(`PRAGMA user_version = ${index + 1}`);
    }
    const projectId = randomUUID();
    raw.prepare("INSERT INTO projects(id, data) VALUES (?, ?)").run(projectId, JSON.stringify({ id: projectId, ownerId: "local", appId: "ugc-creator", name: "Old", brief: null, parentProjectId: null, origin: null, revision: 0, createdAt: 1, updatedAt: 1 }));
    const brief = { productSummary: "Ridgeline", audience: "Commuters", platforms: ["TikTok"], tone: "Warm" };
    for (const version of [1, 2]) {
      raw
        .prepare("INSERT INTO document_versions(kind, subject_id, version, data) VALUES ('brief', ?, ?, ?)")
        .run(projectId, version, JSON.stringify({ kind: "brief", subjectId: projectId, ownerId: "local", version, author: "user", restoredFrom: null, createdAt: version, content: { ...brief, tone: `Warm ${version}` } }));
    }
    assert.throws(() => raw.prepare("INSERT INTO document_versions(kind, subject_id, version, data) VALUES ('piece', ?, 1, ?)").run(projectId, JSON.stringify({ kind: "piece", subjectId: projectId, version: 1 })), "version 7 refuses the piece kind");
    raw.close();

    const store = openStore(dir);
    cleanups.push(() => store.close());
    assert.deepEqual(store.documents.list("brief", projectId).map((version) => (version.kind === "brief" ? version.content.tone : null)), ["Warm 1", "Warm 2"]);
    const now = clock();
    const tools: ToolContext = { store, now, newId: randomUUID };
    const piece = insertPiece(tools, memo(projectId, now()));
    assert.equal(store.documents.latest("piece", piece.id)?.kind, "piece");
    assert.throws(() => store.database.prepare("INSERT INTO plugin_pieces(id, project_id, type, data) VALUES (?, ?, 'memo', ?)").run(randomUUID(), projectId, JSON.stringify({ id: "other" })));
  });
});
