/**
 * Scripts with immutable version history.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { fail } from "@/lib/domain/failure";
import { type Script, ScriptSchema } from "@/lib/domain/script";
import { decode, decodeAll, encode, transaction, writeRevision } from "@/server/store/connection";

export function scriptRepository(database: DatabaseSync) {
  function get(id: string, version?: number): Script | undefined {
    const row =
      version === undefined
        ? database.prepare("SELECT data FROM scripts WHERE id = ?").get(id)
        : database.prepare("SELECT data FROM script_versions WHERE script_id = ? AND version = ?").get(id, version);
    return row ? decode(row, ScriptSchema) : undefined;
  }

  function getRequired(id: string): Script {
    return get(id) ?? fail("not_found", "This script could not be found.");
  }

  function listByProject(projectId: string): Script[] {
    const rows = database
      .prepare("SELECT data FROM scripts WHERE project_id = ? ORDER BY json_extract(data, '$.updatedAt') DESC, rowid DESC")
      .all(projectId);
    return decodeAll(rows, ScriptSchema);
  }

  function listVersions(id: string): Script[] {
    const rows = database.prepare("SELECT data FROM script_versions WHERE script_id = ? ORDER BY version").all(id);
    return decodeAll(rows, ScriptSchema);
  }

  function create(script: Script): Script {
    const { record, json } = encode(ScriptSchema, script);
    if (record.version !== 1) fail("invalid", "A new script starts at version 1.");
    return transaction(database, () => {
      database.prepare("INSERT INTO scripts(id, project_id, data) VALUES (?, ?, ?)").run(record.id, record.projectId, json);
      database.prepare("INSERT INTO script_versions(script_id, version, data) VALUES (?, ?, ?)").run(record.id, 1, json);
      return record;
    });
  }

  /** Saves the next version and keeps the previous one in history. A stale version is a conflict. */
  function saveVersion(next: Script): Script {
    const { record, json } = encode(ScriptSchema, next);
    return transaction(database, () => {
      const current = getRequired(record.id);
      if (current.projectId !== record.projectId) fail("invalid", "A script cannot move between projects.");
      writeRevision(database, "scripts", "id = ?", [record.id], json, record.version, "version");
      database
        .prepare("INSERT INTO script_versions(script_id, version, data) VALUES (?, ?, ?)")
        .run(record.id, record.version, json);
      return record;
    });
  }

  return { get, getRequired, listByProject, listVersions, create, saveVersion };
}
export type ScriptRepository = ReturnType<typeof scriptRepository>;
