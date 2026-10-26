import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { toFailure } from "@/lib/domain/failure";
import { saveBrief } from "@/lib/domain/project";
import { resolveMediaPath } from "@/server/media/paths";
import { DATABASE_FILE, SCHEMA_VERSION, openStore } from "@/server/store";
import { clock, generateAssets, seedProject, tempDir, tempStore } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("migrations", () => {
  test("an empty directory migrates to version 1 with WAL, foreign keys, and media folders", () => {
    const { store, dir, cleanup } = tempStore();
    cleanups.push(cleanup);
    assert.equal(SCHEMA_VERSION, 1);
    const pragma = (sql: string) => Object.values(store.database.prepare(sql).get()!)[0];
    assert.equal(pragma("PRAGMA user_version"), 1);
    assert.equal(pragma("PRAGMA journal_mode"), "wal");
    assert.equal(pragma("PRAGMA foreign_keys"), 1);
    const tables = store.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [
      "assets",
      "content_pieces",
      "exports",
      "jobs",
      "library_items",
      "project_links",
      "projects",
      "script_versions",
      "scripts",
      "workspace",
    ]);
    for (const folder of ["media", "references", "exports"]) assert.ok(existsSync(join(dir, folder)));
  });

  test("reopening is a no-op and a newer database is refused", () => {
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    openStore(dir).close();
    openStore(dir).close();
    const raw = new DatabaseSync(join(dir, DATABASE_FILE));
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    assert.throws(
      () => openStore(dir),
      (error) => toFailure(error).code === "storage" && /newer version/.test(toFailure(error).message),
    );
  });

  test("foreign keys and JSON checks reject inconsistent rows", () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const id = "00000000-0000-4000-8000-000000000000";
    assert.throws(() => store.database.prepare("INSERT INTO projects(id, data) VALUES (?, ?)").run(id, "{\"id\":\"other\"}"));
    assert.throws(() =>
      store.database
        .prepare("INSERT INTO scripts(id, project_id, data) VALUES (?, ?, ?)")
        .run(id, id, JSON.stringify({ id, projectId: id })),
    );
  });

  test("records are validated on read", () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    store.database.prepare("UPDATE projects SET data = json_set(data, '$.appId', 'other') WHERE id = ?").run(project.id);
    assert.throws(() => store.projects.get(project.id));
  });
});

describe("durability", () => {
  test("a project and a completed mock job survive a restart and a relocated data directory", async () => {
    const dir = tempDir();
    const moved = tempDir();
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    });
    const now = clock();
    let store = openStore(dir);
    const project = seedProject(store, now);
    const { job, assetIds } = await generateAssets(store, now, { projectId: project.id });
    store.close();

    store = openStore(dir);
    assert.equal(store.projects.getRequired(project.id).name, project.name);
    assert.equal(store.jobs.getRequired(job.id).status, "completed");
    store.close();

    cpSync(dir, moved, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    store = openStore(moved);
    const asset = store.assets.getRequired(assetIds[0]);
    assert.ok(readFileSync(resolveMediaPath(store.dataDir, asset.relativePath)).length > 0);
    assert.ok(asset.relativePath.startsWith("media/"));
    store.close();
  });

  test("a stale revision is a conflict and an identical write is a no-op", () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    const brief = { productSummary: "Ridgeline 32 oz bottle", audience: "Commuters", platforms: ["Reels"], tone: "Warm" };
    const first = store.projects.update(saveBrief(project, brief, now()));
    assert.deepEqual(store.projects.update(first), first);
    assert.throws(() => store.projects.update(saveBrief(project, { ...brief, tone: "Dry" }, now())), (e) => toFailure(e).code === "conflict");
  });

  test("workspace settings default to zero allowance and save with revisions", () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    assert.equal(store.workspace.get().allowanceUsd, 0);
    const saved = store.workspace.update({ defaultRecipes: { image_to_video: "ltx-2.5-i2v-cloud" } }, 1);
    assert.equal(saved.revision, 1);
    assert.equal(store.workspace.get().defaultRecipes.image_to_video, "ltx-2.5-i2v-cloud");
    assert.throws(() => store.workspace.update({ autoApprove: true, revision: 0 }, 2), (e) => toFailure(e).code === "conflict");
  });

  test("nested transactions roll back as a unit", () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    assert.throws(() =>
      store.transaction(() => {
        seedProject(store, now, "Inside");
        store.transaction(() => seedProject(store, now, "Nested"));
        throw new Error("abort");
      }),
    );
    assert.equal(store.projects.list().length, 0);
  });
});
