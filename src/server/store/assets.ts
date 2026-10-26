/**
 * Asset records. Files live under the data directory; rows hold relative paths and hashes.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { type Asset, type AssetKind, AssetSchema, type AssetState } from "@/lib/domain/asset";
import { fail } from "@/lib/domain/failure";
import { decode, decodeAll, encode, writeRevision } from "@/server/store/connection";

export interface AssetFilter {
  projectId?: string;
  kind?: AssetKind;
  state?: AssetState["state"] | "any";
  recipeId?: string;
  jobId?: string;
  limit?: number;
}

function jobIdOf(asset: Asset): string | null {
  return asset.provenance.source === "generated" ? asset.provenance.jobId : null;
}

export function assetRepository(database: DatabaseSync) {
  function get(id: string): Asset | undefined {
    const row = database.prepare("SELECT data FROM assets WHERE id = ?").get(id);
    return row ? decode(row, AssetSchema) : undefined;
  }

  function getRequired(id: string): Asset {
    return get(id) ?? fail("not_found", "This asset could not be found.");
  }

  /** Lists assets, newest first. State defaults to active. */
  function list(filter: AssetFilter = {}): Asset[] {
    const state = filter.state ?? "active";
    const rows = database
      .prepare(
        `SELECT data FROM assets
         WHERE (? IS NULL OR project_id = ?)
           AND (? IS NULL OR json_extract(data, '$.kind') = ?)
           AND (? = 'any' OR json_extract(data, '$.state.state') = ?)
           AND (? IS NULL OR json_extract(data, '$.provenance.recipeId') = ?)
           AND (? IS NULL OR job_id = ?)
         ORDER BY json_extract(data, '$.createdAt') DESC, rowid DESC
         LIMIT ?`,
      )
      .all(
        filter.projectId ?? null,
        filter.projectId ?? null,
        filter.kind ?? null,
        filter.kind ?? null,
        state,
        state,
        filter.recipeId ?? null,
        filter.recipeId ?? null,
        filter.jobId ?? null,
        filter.jobId ?? null,
        filter.limit ?? 10_000,
      );
    return decodeAll(rows, AssetSchema);
  }

  function findUpload(projectId: string | null, originalSha256: string): Asset | undefined {
    const row = database
      .prepare(
        `SELECT data FROM assets
         WHERE project_id IS ? AND json_extract(data, '$.provenance.source') = 'upload'
           AND json_extract(data, '$.provenance.originalSha256') = ?
           AND json_extract(data, '$.state.state') != 'deleted'
         LIMIT 1`,
      )
      .get(projectId, originalSha256);
    return row ? decode(row, AssetSchema) : undefined;
  }

  function insert(asset: Asset): Asset {
    const { record, json } = encode(AssetSchema, asset);
    database
      .prepare("INSERT INTO assets(id, project_id, job_id, data) VALUES (?, ?, ?, ?)")
      .run(record.id, record.projectId, jobIdOf(record), json);
    return record;
  }

  /** Saves the next revision. Identity, file, and provenance are immutable. */
  function update(next: Asset): Asset {
    const { record, json } = encode(AssetSchema, next);
    const current = getRequired(record.id);
    if (
      current.relativePath !== record.relativePath ||
      current.sha256 !== record.sha256 ||
      current.projectId !== record.projectId ||
      JSON.stringify(current.provenance) !== JSON.stringify(record.provenance)
    ) {
      fail("invalid", "An asset's file and provenance cannot change.");
    }
    writeRevision(database, "assets", "id = ?", [record.id], json, record.revision);
    return record;
  }

  return { get, getRequired, list, findUpload, insert, update };
}
export type AssetRepository = ReturnType<typeof assetRepository>;
