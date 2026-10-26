/**
 * Durable generation jobs: idempotent admission by request id, optimistic status transitions,
 * and the atomic output commit (terminal job state and asset rows in one transaction).
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { type Asset, AssetSchema } from "@/lib/domain/asset";
import { fail } from "@/lib/domain/failure";
import { type Job, JobSchema } from "@/lib/domain/job";
import { decode, decodeAll, encode, transaction } from "@/server/store/connection";

function sameRequest(a: Job, b: Job): boolean {
  return (
    a.projectId === b.projectId &&
    a.recipeId === b.recipeId &&
    a.capability === b.capability &&
    a.executor === b.executor &&
    JSON.stringify(a.request) === JSON.stringify(b.request)
  );
}

export function jobRepository(database: DatabaseSync) {
  function get(id: string): Job | undefined {
    const row = database.prepare("SELECT data FROM jobs WHERE id = ?").get(id);
    return row ? decode(row, JobSchema) : undefined;
  }

  function getRequired(id: string): Job {
    return get(id) ?? fail("not_found", "This job could not be found.");
  }

  function getByRequest(requestId: string): Job | undefined {
    const row = database.prepare("SELECT data FROM jobs WHERE request_id = ?").get(requestId);
    return row ? decode(row, JobSchema) : undefined;
  }

  /**
   * Admits a job once per request id. A retry with the same request returns the saved job;
   * the same request id with different contents is a conflict.
   */
  function add(job: Job): { job: Job; created: boolean } {
    const { record, json } = encode(JobSchema, job);
    return transaction(database, () => {
      const existing = getByRequest(record.requestId);
      if (existing) {
        if (!sameRequest(existing, record)) fail("conflict", "This request id was already used for a different generation.");
        return { job: existing, created: false };
      }
      database
        .prepare("INSERT INTO jobs(id, project_id, request_id, status, data) VALUES (?, ?, ?, ?, ?)")
        .run(record.id, record.projectId, record.requestId, record.status, json);
      return { job: record, created: true };
    });
  }

  function listByProject(projectId: string): Job[] {
    const rows = database
      .prepare("SELECT data FROM jobs WHERE project_id = ? ORDER BY json_extract(data, '$.createdAt') DESC, rowid DESC")
      .all(projectId);
    return decodeAll(rows, JobSchema);
  }

  /** Jobs to resume after a restart: everything not completed or failed, oldest first. */
  function listUnfinished(): Job[] {
    const rows = database
      .prepare(
        "SELECT data FROM jobs WHERE status NOT IN ('completed', 'failed') ORDER BY json_extract(data, '$.createdAt'), rowid",
      )
      .all();
    return decodeAll(rows, JobSchema);
  }

  /**
   * Saves `next` only if the stored job is still `previous` (same revision, not terminal).
   * Returns false when another worker won; reload and decide again.
   */
  function transition(previous: Job, next: Job): boolean {
    if (previous.id !== next.id || previous.requestId !== next.requestId) fail("invalid", "A job cannot change identity.");
    if (next.revision !== previous.revision + 1) fail("invalid", "A job transition bumps the revision by one.");
    if (next.status === "completed") fail("invalid", "Complete a job through the output commit.");
    const { record, json } = encode(JobSchema, next);
    const result = database
      .prepare(
        `UPDATE jobs SET data = ?, status = ? WHERE id = ?
           AND json_extract(data, '$.revision') = ? AND status NOT IN ('completed', 'failed')`,
      )
      .run(json, record.status, record.id, previous.revision);
    return result.changes > 0;
  }

  /**
   * Marks the job completed and inserts its asset rows in one transaction. Returns false (and
   * writes nothing) when the job already moved on. Run inside a larger transaction to also
   * attach the outputs to their target.
   */
  function commitOutputs(completed: Job, assets: Asset[]): boolean {
    const { record, json } = encode(JobSchema, completed);
    if (record.status !== "completed") fail("invalid", "Only a completed job commits outputs.");
    const checked = assets.map((asset) => AssetSchema.parse(asset));
    const ids = checked.map((asset) => asset.id);
    if (ids.length !== record.outputs.length || !record.outputs.every((id, position) => ids[position] === id)) {
      fail("invalid", "The job's outputs must match the committed assets.");
    }
    for (const asset of checked) {
      if (asset.provenance.source !== "generated" || asset.provenance.jobId !== record.id || asset.projectId !== record.projectId) {
        fail("invalid", "An output does not belong to this job.");
      }
    }
    return transaction(database, () => {
      const result = database
        .prepare(
          `UPDATE jobs SET data = ?, status = 'completed' WHERE id = ?
             AND json_extract(data, '$.revision') = ? AND status NOT IN ('completed', 'failed')`,
        )
        .run(json, record.id, record.revision - 1);
      if (result.changes === 0) return false;
      const insert = database.prepare("INSERT INTO assets(id, project_id, job_id, data) VALUES (?, ?, ?, ?)");
      for (const asset of checked) insert.run(asset.id, asset.projectId, record.id, JSON.stringify(asset));
      return true;
    });
  }

  return { get, getRequired, getByRequest, add, listByProject, listUnfinished, transition, commitOutputs };
}
export type JobRepository = ReturnType<typeof jobRepository>;
