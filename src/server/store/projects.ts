/**
 * Project records.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { fail } from "@/lib/domain/failure";
import { type Project, ProjectSchema } from "@/lib/domain/project";
import { decode, decodeAll, encode, writeRevision } from "@/server/store/connection";

export function projectRepository(database: DatabaseSync) {
  function get(id: string): Project | undefined {
    const row = database.prepare("SELECT data FROM projects WHERE id = ?").get(id);
    return row ? decode(row, ProjectSchema) : undefined;
  }

  function getRequired(id: string): Project {
    return get(id) ?? fail("not_found", "This project could not be found.");
  }

  function list(): Project[] {
    const rows = database
      .prepare("SELECT data FROM projects ORDER BY json_extract(data, '$.updatedAt') DESC, rowid DESC")
      .all();
    return decodeAll(rows, ProjectSchema);
  }

  function create(project: Project): Project {
    const { record, json } = encode(ProjectSchema, project);
    database.prepare("INSERT INTO projects(id, data) VALUES (?, ?)").run(record.id, json);
    return record;
  }

  /** Saves the next revision; a stale revision is a conflict. */
  function update(next: Project): Project {
    const { record, json } = encode(ProjectSchema, next);
    writeRevision(database, "projects", "id = ?", [record.id], json, record.revision);
    return record;
  }

  return { get, getRequired, list, create, update };
}
export type ProjectRepository = ReturnType<typeof projectRepository>;
