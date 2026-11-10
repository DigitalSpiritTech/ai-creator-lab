/**
 * F8 phase B, first half: the owner carried on records and requests, optional project parents
 * (validated, no cycles), App ids checked against the registry, and the inbound context that seeds
 * a project with a brief and Library links (the gallery's "start from example").
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { toFailure } from "@creator-lab/core/domain/failure";
import { InboundContextSchema, resolveLibraryRefs } from "@creator-lab/core/domain/inbound";
import { createCharacter, createProduct, setLibraryItemArchived } from "@creator-lab/core/domain/library";
import { DEFAULT_OWNER_ID } from "@creator-lab/core/domain/owner";
import { AppIdSchema, MAX_PROJECT_DEPTH, type Project, checkParent, createProject, setProjectParent } from "@creator-lab/core/domain/project";
import { createPluginRegistry } from "@creator-lab/core/registry";
import { DATABASE_FILE, openStore } from "@/server/store";
import { MIGRATIONS } from "@/server/store/migrations";
import { requestOwner } from "@/server/owner";
import { fileURLToPath } from "node:url";
import { type ToolContext, callTool, createGenerationContext } from "@/server/tools";
import { moveProject, startProject } from "@/server/tools/project";
import { averyBible, clock, generateAssets, ridgelineProduct, seedProject, tempDir, tempStore } from "./support/domain-fixtures";
import { RIDGELINE_EXAMPLE_REF, ridgelineExample } from "./support/inbound-fixtures";

const workflowsDir = fileURLToPath(new URL("../packages/recipes/workflows", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const tools: ToolContext = { store: context.store, now, newId: randomUUID };
  return { ...context, now, tools };
}

const failure = (code: string, pattern: RegExp) => (error: unknown) => toFailure(error).code === code && pattern.test(toFailure(error).message);

describe("owner context", () => {
  test("new records belong to the default owner; the request context carries it", async () => {
    const { store, now, tools } = setup();
    assert.equal(requestOwner(new Request("http://localhost/api/projects")), DEFAULT_OWNER_ID);
    const project = seedProject(store, now);
    assert.equal(project.ownerId, "local");
    const saved = await callTool(tools, "save_character_bible", { bible: averyBible(), projectId: project.id });
    assert.ok(saved.ok);
    const character = (saved.output as { character: { ownerId: string } }).character;
    assert.equal(character.ownerId, "local");
    const { job, assetIds } = await generateAssets(store, now, { projectId: project.id });
    assert.equal(job.ownerId, "local");
    assert.equal(store.assets.getRequired(assetIds[0]).ownerId, "local");
    const brief = { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters", platforms: ["TikTok"], tone: "Warm" };
    assert.ok((await callTool(tools, "save_brief", { projectId: project.id, brief })).ok);
    assert.equal(store.documents.latest("brief", project.id)?.ownerId, "local");
  });

  test("a project created for another owner keeps it, and its jobs and assets inherit it", async () => {
    const { store, now } = setup();
    const project = store.projects.create(createProject({ name: "Team launch" }, randomUUID(), now(), { ownerId: "team-a" }));
    assert.equal(project.ownerId, "team-a");
    const tools: ToolContext = { store, now, newId: randomUUID, generation: createGenerationContext(store, { workflowsDir }), ownerId: "team-a" };
    const proposal = await callTool(tools, "propose_candidates", { projectId: project.id, capability: "text_to_image", recipeId: "mock-text-to-image", prompt: "A dark green bottle on a counter", count: 1 });
    assert.ok(proposal.ok);
    const submitted = await callTool(tools, "submit_proposal", { proposal: proposal.output, wait: true });
    assert.ok(submitted.ok);
    const [result] = (submitted.output as { results: { job: { ownerId: string }; assetIds: string[] }[] }).results;
    assert.equal(result.job.ownerId, "team-a");
    assert.equal(store.assets.getRequired(result.assetIds[0]).ownerId, "team-a");
    assert.throws(() => createProject({ name: "Bad" }, randomUUID(), now(), { ownerId: "Not An Owner" }));
  });
});

describe("App ids", () => {
  test("any well-formed App id parses; malformed ones do not", () => {
    assert.equal(AppIdSchema.parse("ugc-creator"), "ugc-creator");
    assert.equal(AppIdSchema.parse("jingle-maker"), "jingle-maker");
    for (const bad of ["", "UGC", "has space", "-lead", "x".repeat(41)]) assert.equal(AppIdSchema.safeParse(bad).success, false, bad);
  });

  test("a project is created only in an installed App, with the installed Apps named", () => {
    const { store, tools } = setup();
    assert.throws(
      () => startProject(tools, { name: "Jingle", appId: "jingle-maker" }),
      failure("invalid", /no installed App "jingle-maker"\. Installed Apps: UGC Creator \(ugc-creator\)/),
    );
    assert.equal(store.projects.list().length, 0);
    const registry = createPluginRegistry();
    registry.registerPlugin({
      id: "jingles",
      label: "Jingles",
      contentTypes: [{ id: "jingle", label: "Jingle", app: { id: "jingle-maker", label: "Jingle Maker" }, description: "A sting.", pieceType: "jingle", defaultPanel: "jingles.edit" }],
      panels: [{ id: "jingles.edit", contentType: "jingle", title: "Edit" }],
    });
    const { project } = startProject(tools, { name: "Jingle", appId: "jingle-maker" }, registry);
    assert.equal(project.appId, "jingle-maker");
    assert.equal(startProject(tools, { name: "Default App" }).project.appId, "ugc-creator");
  });
});

describe("project parents", () => {
  const node = (id: string, parentProjectId: string | null, ownerId = "local"): Pick<Project, "id" | "ownerId" | "parentProjectId"> => ({ id, ownerId, parentProjectId });

  test("checkParent refuses a missing parent, another owner's, the project itself, a cycle, and a chain too deep", () => {
    const projects = new Map([node("a", null), node("b", "a"), node("c", "b"), node("t", null, "team-a")].map((p) => [p.id, p]));
    const lookup = (id: string) => projects.get(id);
    assert.doesNotThrow(() => checkParent("new", null, "local", lookup));
    assert.doesNotThrow(() => checkParent("new", "c", "local", lookup));
    assert.throws(() => checkParent("new", "missing", "local", lookup), failure("not_found", /parent project could not be found/));
    assert.throws(() => checkParent("new", "t", "local", lookup), failure("not_found", /parent project could not be found/));
    assert.throws(() => checkParent("a", "a", "local", lookup), failure("invalid", /its own parent/));
    assert.throws(() => checkParent("a", "c", "local", lookup), failure("invalid", /cannot contain itself/));
    const chain = new Map<string, Pick<Project, "id" | "ownerId" | "parentProjectId">>();
    for (let index = 0; index < MAX_PROJECT_DEPTH; index++) chain.set(`p${index}`, node(`p${index}`, index ? `p${index - 1}` : null));
    assert.throws(() => checkParent("new", `p${MAX_PROJECT_DEPTH - 1}`, "local", (id) => chain.get(id)), failure("invalid", /nest at most/));
  });

  test("setProjectParent moves a project, is a no-op for the same parent, and refuses a cycle", () => {
    const now = clock();
    const top = createProject({ name: "Campaign" }, randomUUID(), now());
    const child = createProject({ name: "Piece", parentProjectId: top.id }, randomUUID(), now());
    const lookup = (id: string) => [top, child].find((project) => project.id === id);
    assert.equal(setProjectParent(child, top.id, lookup, now()), child);
    assert.throws(() => setProjectParent(top, child.id, lookup, now()), failure("invalid", /cannot contain itself/));
    const moved = setProjectParent(child, null, lookup, now());
    assert.equal(moved.parentProjectId, null);
    assert.equal(moved.revision, child.revision + 1);
  });

  test("startProject and moveProject validate the parent against the store", () => {
    const { tools } = setup();
    const campaign = startProject(tools, { name: "Autumn campaign" }).project;
    const piece = startProject(tools, { name: "Cup holder ad", parentProjectId: campaign.id }).project;
    assert.equal(piece.parentProjectId, campaign.id);
    assert.throws(() => startProject(tools, { name: "Orphan", parentProjectId: randomUUID() }), failure("not_found", /parent project/));
    assert.throws(() => moveProject(tools, campaign.id, piece.id), failure("invalid", /cannot contain itself/));
    assert.equal(moveProject(tools, piece.id, null).parentProjectId, null);
    assert.throws(() => moveProject({ ...tools, ownerId: "team-a" }, piece.id, campaign.id), failure("not_found", /could not be found/), "another owner's request cannot move it");
  });
});

describe("inbound context", () => {
  test("seeds a project from a fixture gallery example: brief as version 1, Library items linked, origin kept", async () => {
    const { store, tools } = setup();
    const avery = await callTool(tools, "save_character_bible", { bible: averyBible() });
    const ridgeline = await callTool(tools, "save_product", { product: ridgelineProduct() });
    assert.ok(avery.ok && ridgeline.ok);
    const characterId = (avery.output as { character: { id: string } }).character.id;
    const productId = (ridgeline.output as { product: { id: string } }).product.id;

    const { project, links } = startProject(tools, ridgelineExample({ characterId, productId }));
    assert.equal(project.name, "Ridgeline launch (from example)");
    assert.deepEqual(project.origin, { kind: "gallery", ref: RIDGELINE_EXAMPLE_REF });
    assert.equal(project.brief?.platforms.join(", "), "TikTok, Instagram Reels");
    assert.deepEqual(links.map((link) => [link.kind, link.itemId]), [["character", characterId], ["product", productId]]);

    const versions = await callTool(tools, "list_document_versions", { kind: "brief", subjectId: project.id });
    assert.ok(versions.ok);
    const history = versions.output as { current: number; versions: { version: number; author: string | null; ownerId: string }[] };
    assert.deepEqual(history.versions.map((version) => version.version), [1]);
    assert.equal(history.current, 1);
    assert.equal(history.versions[0].ownerId, "local");

    const state = await callTool(tools, "get_project_state", { projectId: project.id });
    assert.ok(state.ok);
    const output = state.output as { characters: unknown[]; products: { id: string }[] };
    assert.equal(output.characters.length, 1);
    assert.equal(output.products[0].id, productId);
    assert.equal(store.projects.list().length, 1);
  });

  test("a bad reference creates nothing: wrong kind, missing, archived, or another owner's item", () => {
    const { store, now, tools } = setup();
    const avery = store.library.create(createCharacter(randomUUID(), averyBible(), now()));
    const product = store.library.create(createProduct(randomUUID(), ridgelineProduct(), now()));
    const theirs = store.library.create(createProduct(randomUUID(), ridgelineProduct(), now(), "team-a"));
    const source = { kind: "gallery" as const, ref: "example" };
    const attempt = (libraryRefs: { kind: "character" | "product" | "set"; id: string }[]) => () =>
      startProject(tools, { name: "Seeded", inbound: { libraryRefs, source } });
    assert.throws(attempt([{ kind: "product", id: avery.id }]), failure("invalid", /is a character, not a product/));
    assert.throws(attempt([{ kind: "set", id: randomUUID() }]), failure("not_found", /could not be found/));
    assert.throws(attempt([{ kind: "product", id: theirs.id }]), failure("not_found", /could not be found/));
    store.library.update(setLibraryItemArchived(product, true, now()));
    assert.throws(attempt([{ kind: "product", id: product.id }]), failure("invalid", /archived/));
    assert.equal(store.projects.list().length, 0, "the transaction rolled back every attempt");
    assert.equal(InboundContextSchema.safeParse({ libraryRefs: [{ kind: "product", id: avery.id }, { kind: "product", id: avery.id }], source }).success, false);
    assert.deepEqual(resolveLibraryRefs([], "local", () => undefined), []);
  });

  test("POST /api/projects-style input: an inbound context without a brief only links", () => {
    const { store, now, tools } = setup();
    const avery = store.library.create(createCharacter(randomUUID(), averyBible(), now()));
    const { project, links } = startProject(tools, { name: "Avery again", inbound: { libraryRefs: [{ kind: "character", id: avery.id }], source: { kind: "api", ref: "cli" } } });
    assert.equal(project.brief, null);
    assert.equal(links.length, 1);
    assert.deepEqual(store.documents.list("brief", project.id), []);
  });
});

describe("migration 7", () => {
  test("a version 6 database gets the default owner on every owned row, and no parent or origin", () => {
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const raw = new DatabaseSync(join(dir, DATABASE_FILE));
    for (const [index, sql] of MIGRATIONS.slice(0, 6).entries()) {
      raw.exec(sql);
      raw.exec(`PRAGMA user_version = ${index + 1}`);
    }
    const projectId = randomUUID();
    const itemId = randomUUID();
    // Rows exactly as version 6 wrote them: no ownerId, parentProjectId, or origin.
    const legacyProject = { id: projectId, appId: "ugc-creator", name: "Old launch", brief: null, revision: 0, createdAt: 1, updatedAt: 1 };
    raw.prepare("INSERT INTO projects(id, data) VALUES (?, ?)").run(projectId, JSON.stringify(legacyProject));
    const { ownerId: _owner, ...legacyItem } = createProduct(itemId, ridgelineProduct(), 1);
    void _owner;
    raw.prepare("INSERT INTO library_items(id, kind, data) VALUES (?, 'product', ?)").run(itemId, JSON.stringify(legacyItem));
    const brief = { productSummary: "Ridgeline", audience: "Commuters", platforms: ["TikTok"], tone: "Warm" };
    raw
      .prepare("INSERT INTO document_versions(kind, subject_id, version, data) VALUES ('brief', ?, 1, ?)")
      .run(projectId, JSON.stringify({ kind: "brief", subjectId: projectId, version: 1, author: null, restoredFrom: null, createdAt: 1, content: brief }));
    raw.close();

    const store = openStore(dir);
    cleanups.push(() => store.close());
    const stored = (table: string, id: string) => JSON.parse(String(store.database.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id)!.data)) as Record<string, unknown>;
    assert.deepEqual(
      [stored("projects", projectId).ownerId, stored("projects", projectId).parentProjectId, stored("projects", projectId).origin],
      ["local", null, null],
      "the stored row is rewritten, not only read through a default",
    );
    assert.equal(stored("library_items", itemId).ownerId, "local");
    assert.equal(store.documents.latest("brief", projectId)?.ownerId, "local");
    const project = store.projects.getRequired(projectId);
    assert.equal(project.ownerId, "local");
    assert.equal(project.parentProjectId, null);
    // The owner indexes exist for later multi-owner listings.
    const indexes = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_owner'").all().map((row) => row.name);
    assert.deepEqual(indexes.sort(), ["assets_owner", "library_items_owner", "projects_owner"]);
  });
});
