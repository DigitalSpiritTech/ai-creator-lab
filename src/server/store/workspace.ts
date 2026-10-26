/**
 * The single workspace settings row.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type UpdateWorkspaceSettings,
  type WorkspaceSettings,
  WorkspaceSettingsSchema,
  updateWorkspaceSettings,
} from "@/lib/domain/workspace";
import { decode, encode, transaction } from "@/server/store/connection";

export function workspaceRepository(database: DatabaseSync) {
  function get(): WorkspaceSettings {
    const row = database.prepare("SELECT data FROM workspace WHERE id = 1").get();
    return row ? decode(row, WorkspaceSettingsSchema) : DEFAULT_WORKSPACE_SETTINGS;
  }

  function update(patch: UpdateWorkspaceSettings, now: number): WorkspaceSettings {
    return transaction(database, () => {
      const { record, json } = encode(WorkspaceSettingsSchema, updateWorkspaceSettings(get(), patch, now));
      database
        .prepare("INSERT INTO workspace(id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
        .run(json);
      return record;
    });
  }

  return { get, update };
}
export type WorkspaceRepository = ReturnType<typeof workspaceRepository>;
