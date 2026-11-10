/**
 * Plugin content pieces (a Social Post), one row each. The envelope and slots are checked by
 * `PluginPieceSchema`; the body is checked by its plugin before it reaches the store.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { fail } from "@creator-lab/core/domain/failure";
import { type PluginPiece, type PluginPieceInput, PluginPieceSchema } from "@creator-lab/core/domain/piece";
import { decode, decodeAll, encode, writeRevision } from "@/server/store/connection";

export function pieceRepository(database: DatabaseSync) {
  function get(id: string): PluginPiece | undefined {
    const row = database.prepare("SELECT data FROM plugin_pieces WHERE id = ?").get(id);
    return row ? decode(row, PluginPieceSchema) : undefined;
  }

  function getRequired(id: string): PluginPiece {
    return get(id) ?? fail("not_found", "This content piece could not be found.");
  }

  /** A project's pieces, newest first, optionally of one type. */
  function listByProject(projectId: string, type?: string): PluginPiece[] {
    const rows = database
      .prepare(
        "SELECT data FROM plugin_pieces WHERE project_id = ? AND (? IS NULL OR type = ?) ORDER BY json_extract(data, '$.createdAt') DESC, rowid DESC",
      )
      .all(projectId, type ?? null, type ?? null);
    return decodeAll(rows, PluginPieceSchema);
  }

  function listAll(): PluginPiece[] {
    return decodeAll(database.prepare("SELECT data FROM plugin_pieces ORDER BY rowid").all(), PluginPieceSchema);
  }

  function create(piece: PluginPieceInput): PluginPiece {
    const { record, json } = encode(PluginPieceSchema, piece);
    database.prepare("INSERT INTO plugin_pieces(id, project_id, type, data) VALUES (?, ?, ?, ?)").run(record.id, record.projectId, record.type, json);
    return record;
  }

  /** Saves the next revision; a stale revision is a conflict. Project, owner, and type never change. */
  function update(next: PluginPiece): PluginPiece {
    const { record, json } = encode(PluginPieceSchema, next);
    const current = getRequired(record.id);
    if (current.projectId !== record.projectId || current.ownerId !== record.ownerId || current.type !== record.type) {
      fail("invalid", "A content piece cannot move to another project, owner, or type.");
    }
    writeRevision(database, "plugin_pieces", "id = ?", [record.id], json, record.revision);
    return record;
  }

  return { get, getRequired, listByProject, listAll, create, update };
}
export type PieceRepository = ReturnType<typeof pieceRepository>;
