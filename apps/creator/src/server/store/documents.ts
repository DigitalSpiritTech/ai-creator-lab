/**
 * Version history of the brief, character bibles, and product cards. Rows are immutable; the next
 * version is the latest plus one. Script history is kept by the script repository.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  BibleVersionSchema,
  BriefVersionSchema,
  type DocumentAuthor,
  type DocumentContent,
  ProductVersionSchema,
  type StoredDocumentKind,
  type StoredDocumentVersion,
  sameContent,
} from "@creator-lab/core/domain/document";
import { decode, decodeAll, encode, transaction } from "@/server/store/connection";

const StoredVersionSchema: z.ZodType<StoredDocumentVersion> = z.discriminatedUnion("kind", [
  BriefVersionSchema,
  BibleVersionSchema,
  ProductVersionSchema,
]);

export interface DocumentEntry<K extends StoredDocumentKind> {
  kind: K;
  subjectId: string;
  /** The owner of the saving request; the default owner when absent. */
  ownerId?: string;
  content: DocumentContent<K>;
  author: DocumentAuthor | null;
  restoredFrom: number | null;
  createdAt: number;
}

export function documentRepository(database: DatabaseSync) {
  function list(kind: StoredDocumentKind, subjectId: string): StoredDocumentVersion[] {
    const rows = database
      .prepare("SELECT data FROM document_versions WHERE kind = ? AND subject_id = ? ORDER BY version")
      .all(kind, subjectId);
    return decodeAll(rows, StoredVersionSchema);
  }

  function get(kind: StoredDocumentKind, subjectId: string, version: number): StoredDocumentVersion | undefined {
    const row = database
      .prepare("SELECT data FROM document_versions WHERE kind = ? AND subject_id = ? AND version = ?")
      .get(kind, subjectId, version);
    return row ? decode(row, StoredVersionSchema) : undefined;
  }

  function latest(kind: StoredDocumentKind, subjectId: string): StoredDocumentVersion | undefined {
    const row = database
      .prepare("SELECT data FROM document_versions WHERE kind = ? AND subject_id = ? ORDER BY version DESC LIMIT 1")
      .get(kind, subjectId);
    return row ? decode(row, StoredVersionSchema) : undefined;
  }

  /**
   * Appends the next version. A save that changes nothing (the same content as the latest version)
   * records nothing and returns null; a restore is always recorded.
   */
  function record<K extends StoredDocumentKind>(entry: DocumentEntry<K>): StoredDocumentVersion | null {
    return transaction(database, () => {
      const previous = latest(entry.kind, entry.subjectId);
      const candidate = StoredVersionSchema.parse({ ...entry, version: (previous?.version ?? 0) + 1 });
      if (previous && entry.restoredFrom === null && sameContent(previous.content, candidate.content)) return null;
      const { record: saved, json } = encode(StoredVersionSchema, candidate);
      database
        .prepare("INSERT INTO document_versions(kind, subject_id, version, data) VALUES (?, ?, ?, ?)")
        .run(saved.kind, saved.subjectId, saved.version, json);
      return saved;
    });
  }

  return { list, get, latest, record };
}
export type DocumentRepository = ReturnType<typeof documentRepository>;
