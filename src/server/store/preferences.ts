/**
 * Per-project recipe preferences, one row per project. Kept out of the project record so setting a
 * preference never changes the project's revision.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { type ProjectPreferences, ProjectPreferencesSchema, emptyPreferences } from "@/lib/domain/preferences";
import { decode, encode } from "@/server/store/connection";

export function preferencesRepository(database: DatabaseSync) {
  /** The project's preferences; an empty set when none was saved. */
  function get(projectId: string): ProjectPreferences {
    const row = database.prepare("SELECT data FROM project_preferences WHERE project_id = ?").get(projectId);
    return row ? decode(row, ProjectPreferencesSchema) : emptyPreferences(projectId);
  }

  function save(next: ProjectPreferences): ProjectPreferences {
    const { record, json } = encode(ProjectPreferencesSchema, next);
    database
      .prepare("INSERT INTO project_preferences(project_id, data) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data")
      .run(record.projectId, json);
    return record;
  }

  return { get, save };
}
export type PreferencesRepository = ReturnType<typeof preferencesRepository>;
