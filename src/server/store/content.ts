/**
 * Content pieces (shots and cut) and their export records.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { type ContentPiece, ContentPieceSchema, type ExportRecord, ExportRecordSchema } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import { decode, decodeAll, encode, writeRevision } from "@/server/store/connection";

export function contentRepository(database: DatabaseSync) {
  function get(id: string): ContentPiece | undefined {
    const row = database.prepare("SELECT data FROM content_pieces WHERE id = ?").get(id);
    return row ? decode(row, ContentPieceSchema) : undefined;
  }

  function getRequired(id: string): ContentPiece {
    return get(id) ?? fail("not_found", "This content piece could not be found.");
  }

  function listByProject(projectId: string): ContentPiece[] {
    const rows = database
      .prepare(
        "SELECT data FROM content_pieces WHERE project_id = ? ORDER BY json_extract(data, '$.createdAt') DESC, rowid DESC",
      )
      .all(projectId);
    return decodeAll(rows, ContentPieceSchema);
  }

  function listByScript(scriptId: string): ContentPiece[] {
    const rows = database.prepare("SELECT data FROM content_pieces WHERE script_id = ? ORDER BY rowid").all(scriptId);
    return decodeAll(rows, ContentPieceSchema);
  }

  function listAll(): ContentPiece[] {
    return decodeAll(database.prepare("SELECT data FROM content_pieces ORDER BY rowid").all(), ContentPieceSchema);
  }

  function create(content: ContentPiece): ContentPiece {
    const { record, json } = encode(ContentPieceSchema, content);
    database
      .prepare("INSERT INTO content_pieces(id, project_id, script_id, data) VALUES (?, ?, ?, ?)")
      .run(record.id, record.projectId, record.scriptId, json);
    return record;
  }

  function update(next: ContentPiece): ContentPiece {
    const { record, json } = encode(ContentPieceSchema, next);
    writeRevision(database, "content_pieces", "id = ?", [record.id], json, record.revision);
    return record;
  }

  function getExport(id: string): ExportRecord | undefined {
    const row = database.prepare("SELECT data FROM exports WHERE id = ?").get(id);
    return row ? decode(row, ExportRecordSchema) : undefined;
  }

  function listExports(contentId?: string): ExportRecord[] {
    const rows = database
      .prepare(
        "SELECT data FROM exports WHERE (? IS NULL OR content_id = ?) ORDER BY json_extract(data, '$.createdAt') DESC, rowid DESC",
      )
      .all(contentId ?? null, contentId ?? null);
    return decodeAll(rows, ExportRecordSchema);
  }

  /** Saves a new rendering export once; a retry with the same id returns the saved record. */
  function addExport(record: ExportRecord): ExportRecord {
    const checked = encode(ExportRecordSchema, record);
    const existing = getExport(checked.record.id);
    if (existing) return existing;
    if (checked.record.status !== "rendering") fail("invalid", "A new export starts rendering.");
    database
      .prepare("INSERT INTO exports(id, content_id, project_id, data) VALUES (?, ?, ?, ?)")
      .run(checked.record.id, checked.record.contentId, checked.record.projectId, checked.json);
    return checked.record;
  }

  /** Moves a rendering export to its terminal state. Returns false if it already finished. */
  function finishExport(record: ExportRecord): boolean {
    const { record: next, json } = encode(ExportRecordSchema, record);
    if (next.status === "rendering") fail("invalid", "An export must finish or fail.");
    const result = database
      .prepare("UPDATE exports SET data = ? WHERE id = ? AND json_extract(data, '$.status') = 'rendering'")
      .run(json, next.id);
    return result.changes > 0;
  }

  /** Records broken references on an export; its sources and result stay as they were. */
  function markExportBroken(id: string, brokenAssetIds: string[]): ExportRecord {
    const current = getExport(id) ?? fail("not_found", "This export could not be found.");
    const { record, json } = encode(ExportRecordSchema, { ...current, brokenAssetIds });
    database.prepare("UPDATE exports SET data = ? WHERE id = ?").run(json, id);
    return record;
  }

  return {
    get,
    getRequired,
    listByProject,
    listByScript,
    listAll,
    create,
    update,
    getExport,
    listExports,
    addExport,
    finishExport,
    markExportBroken,
  };
}
export type ContentRepository = ReturnType<typeof contentRepository>;
