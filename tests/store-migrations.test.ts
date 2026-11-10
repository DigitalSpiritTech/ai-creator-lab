import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { toFailure } from "@/lib/domain/failure";
import { saveBrief } from "@/lib/domain/project";
import { WorkspaceSettingsSchema } from "@/lib/domain/workspace";
import { resolveMediaPath } from "@/server/media/paths";
import { DATABASE_FILE, SCHEMA_VERSION, openStore } from "@/server/store";
import { MIGRATIONS } from "@/server/store/migrations";
import { clock, generateAssets, seedProject, tempDir, tempStore } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("migrations", () => {
  test("an empty directory migrates to the latest version with WAL, foreign keys, and media folders", () => {
    const { store, dir, cleanup } = tempStore();
    cleanups.push(cleanup);
    assert.equal(SCHEMA_VERSION, 6);
    const pragma = (sql: string) => Object.values(store.database.prepare(sql).get()!)[0];
    assert.equal(pragma("PRAGMA user_version"), 6);
    assert.equal(pragma("PRAGMA journal_mode"), "wal");
    assert.equal(pragma("PRAGMA foreign_keys"), 1);
    const tables = store.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [
      "assets",
      "backends",
      "budget_extensions",
      "content_pieces",
      "conversation_messages",
      "document_versions",
      "exports",
      "jobs",
      "library_items",
      "project_links",
      "project_preferences",
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

  test("version 4 turns a saved allowance into the monthly budget with reset day 1 and adds budget extensions", () => {
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const raw = new DatabaseSync(join(dir, DATABASE_FILE));
    for (const [index, sql] of MIGRATIONS.slice(0, 3).entries()) {
      raw.exec(sql);
      raw.exec(`PRAGMA user_version = ${index + 1}`);
    }
    const legacy = { defaultRecipes: {}, routerModels: [], allowanceUsd: 7.5, autoApprove: true, revision: 4, updatedAt: 1 };
    raw.prepare("INSERT INTO workspace(id, data) VALUES (1, ?)").run(JSON.stringify(legacy));
    raw.close();

    const store = openStore(dir);
    cleanups.push(() => store.close());
    const settings = store.workspace.get();
    assert.equal(settings.monthlyBudgetUsd, 7.5);
    assert.equal(settings.budgetResetDay, 1);
    assert.equal(settings.autoApprove, true);
    assert.equal(settings.revision, 4);
    const stored = JSON.parse(String(store.database.prepare("SELECT data FROM workspace WHERE id = 1").get()!.data)) as Record<string, unknown>;
    assert.equal("allowanceUsd" in stored, false, "the stored row is rewritten, not only read through");

    const extension = { id: "00000000-0000-4000-8000-0000000000e1", periodKey: "2026-11-01", amountUsd: 1, createdAt: 2 };
    assert.deepEqual(store.budget.add(extension), { extension, created: true });
    assert.deepEqual(store.budget.add({ ...extension, amountUsd: 9 }), { extension, created: false });
    assert.deepEqual(store.budget.listForPeriod("2026-11-01"), [extension]);
    assert.deepEqual(store.budget.listForPeriod("2026-12-01"), []);
    assert.throws(() =>
      store.database
        .prepare("INSERT INTO budget_extensions(id, period_key, data) VALUES (?, ?, ?)")
        .run("00000000-0000-4000-8000-0000000000e2", "2026-12-01", JSON.stringify({ ...extension, id: "00000000-0000-4000-8000-0000000000e2" })),
    );
  });

  test("version 6 adds project preferences to a version 5 database from either branch, keeping its rows", () => {
    const project = { id: "00000000-0000-4000-8000-0000000000a1" };
    const backend = { id: "studio-pc" };
    // 08's version 5 (backends, no preferences), and 05's pre-merge version 5 (preferences, no backends).
    const variants: { name: string; version5: string }[] = [
      { name: "08's", version5: MIGRATIONS[4] },
      {
        name: "05's pre-merge",
        version5: `CREATE TABLE project_preferences (
          project_id TEXT PRIMARY KEY REFERENCES projects(id),
          data TEXT NOT NULL CHECK (json_valid(data) AND json_extract(data, '$.projectId') = project_id)
        );`,
      },
    ];
    for (const { name, version5 } of variants) {
      const dir = tempDir();
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const raw = new DatabaseSync(join(dir, DATABASE_FILE));
      for (const [index, sql] of [...MIGRATIONS.slice(0, 4), version5].entries()) {
        raw.exec(sql);
        raw.exec(`PRAGMA user_version = ${index + 1}`);
      }
      raw.prepare("INSERT INTO projects(id, data) VALUES (?, ?)").run(project.id, JSON.stringify(project));
      const hasBackends = !!raw.prepare("SELECT name FROM sqlite_master WHERE name = 'backends'").get();
      if (hasBackends) raw.prepare("INSERT INTO backends(id, data) VALUES (?, ?)").run(backend.id, JSON.stringify(backend));
      raw.close();

      const store = openStore(dir);
      cleanups.push(() => store.close());
      assert.equal(Object.values(store.database.prepare("PRAGMA user_version").get()!)[0], 6, name);
      for (const table of ["backends", "project_preferences"]) {
        assert.ok(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${name}: ${table} exists`);
      }
      if (hasBackends) assert.equal(store.database.prepare("SELECT count(*) AS n FROM backends").get()!.n, 1, `${name}: backend rows are kept`);
      assert.deepEqual(store.preferences.get(project.id).recipes, {}, name);
      const saved = store.preferences.save({ projectId: project.id, recipes: { image_edit: "mock-image-edit" }, revision: 1, updatedAt: 1 });
      assert.deepEqual(store.preferences.get(project.id), saved, name);
    }
  });

  test("an old settings row still parses after the rename", () => {
    const parsed = WorkspaceSettingsSchema.parse({ allowanceUsd: 3, autoApprove: false });
    assert.equal(parsed.monthlyBudgetUsd, 3);
    assert.equal(parsed.budgetResetDay, 1);
    assert.equal("allowanceUsd" in parsed, false);
    assert.equal(WorkspaceSettingsSchema.parse({ allowanceUsd: 3, monthlyBudgetUsd: 4 }).monthlyBudgetUsd, 4);
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
    assert.equal(store.workspace.get().monthlyBudgetUsd, 0);
    assert.equal(store.workspace.get().budgetResetDay, 1);
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
