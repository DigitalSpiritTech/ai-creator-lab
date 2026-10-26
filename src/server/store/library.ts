/**
 * Library items (character, product, set) and their links to projects.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { fail } from "@/lib/domain/failure";
import {
  type LibraryItem,
  LibraryItemSchema,
  type LibraryKind,
  type ProjectLink,
  ProjectLinkSchema,
} from "@/lib/domain/library";
import { decode, decodeAll, encode, transaction, writeRevision } from "@/server/store/connection";

export function libraryRepository(database: DatabaseSync) {
  function get(id: string): LibraryItem | undefined {
    const row = database.prepare("SELECT data FROM library_items WHERE id = ?").get(id);
    return row ? decode(row, LibraryItemSchema) : undefined;
  }

  function getRequired(id: string): LibraryItem {
    return get(id) ?? fail("not_found", "This Library item could not be found.");
  }

  function list(filter: { kind?: LibraryKind; includeArchived?: boolean } = {}): LibraryItem[] {
    const rows = database
      .prepare(
        `SELECT data FROM library_items
         WHERE (? IS NULL OR kind = ?) AND (? = 1 OR json_extract(data, '$.archived') = 0)
         ORDER BY json_extract(data, '$.updatedAt') DESC, rowid DESC`,
      )
      .all(filter.kind ?? null, filter.kind ?? null, filter.includeArchived ? 1 : 0);
    return decodeAll(rows, LibraryItemSchema);
  }

  function create(item: LibraryItem): LibraryItem {
    const { record, json } = encode(LibraryItemSchema, item);
    database.prepare("INSERT INTO library_items(id, kind, data) VALUES (?, ?, ?)").run(record.id, record.kind, json);
    return record;
  }

  function update(next: LibraryItem): LibraryItem {
    const { record, json } = encode(LibraryItemSchema, next);
    if (get(record.id)?.kind !== record.kind) fail("invalid", "A Library item cannot change kind.");
    writeRevision(database, "library_items", "id = ?", [record.id], json, record.revision);
    return record;
  }

  function getLink(projectId: string, itemId: string): ProjectLink | undefined {
    const row = database
      .prepare("SELECT data FROM project_links WHERE project_id = ? AND item_id = ?")
      .get(projectId, itemId);
    return row ? decode(row, ProjectLinkSchema) : undefined;
  }

  /** Links an item to a project once; linking again returns the existing link. */
  function link(next: ProjectLink): ProjectLink {
    return transaction(database, () => {
      const existing = getLink(next.projectId, next.itemId);
      if (existing) return existing;
      const item = getRequired(next.itemId);
      if (item.kind !== next.kind) fail("invalid", "The link kind must match the Library item.");
      const { record, json } = encode(ProjectLinkSchema, next);
      database
        .prepare("INSERT INTO project_links(project_id, item_id, data) VALUES (?, ?, ?)")
        .run(record.projectId, record.itemId, json);
      return record;
    });
  }

  function updateLink(next: ProjectLink): ProjectLink {
    const { record, json } = encode(ProjectLinkSchema, next);
    writeRevision(
      database,
      "project_links",
      "project_id = ? AND item_id = ?",
      [record.projectId, record.itemId],
      json,
      record.revision,
    );
    return record;
  }

  function listLinks(projectId: string): ProjectLink[] {
    const rows = database
      .prepare("SELECT data FROM project_links WHERE project_id = ? ORDER BY json_extract(data, '$.linkedAt'), rowid")
      .all(projectId);
    return decodeAll(rows, ProjectLinkSchema);
  }

  function listAllLinks(): ProjectLink[] {
    return decodeAll(database.prepare("SELECT data FROM project_links ORDER BY rowid").all(), ProjectLinkSchema);
  }

  return { get, getRequired, list, create, update, getLink, link, updateLink, listLinks, listAllLinks };
}
export type LibraryRepository = ReturnType<typeof libraryRepository>;
