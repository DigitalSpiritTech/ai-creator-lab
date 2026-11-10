/**
 * Chained takes: one row per proposal candidate made as segments (`ChainSchema`). Admission is
 * idempotent by request id; updates are optimistic by revision. The holds a running chain keeps for
 * segments not yet admitted are read by the spend policy through `outstandingUsd`.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { fail } from "@creator-lab/core/domain/failure";
import { type Chain, type ChainInput, ChainSchema, chainHoldUsd } from "@creator-lab/executors/chain";
import { decode, decodeAll, encode, transaction } from "@/server/store/connection";

export function chainRepository(database: DatabaseSync) {
  function get(id: string): Chain | undefined {
    const row = database.prepare("SELECT data FROM chains WHERE id = ?").get(id);
    return row ? decode(row, ChainSchema) : undefined;
  }

  function getRequired(id: string): Chain {
    return get(id) ?? fail("not_found", "This chained take could not be found.");
  }

  function getByRequest(requestId: string): Chain | undefined {
    const row = database.prepare("SELECT data FROM chains WHERE request_id = ?").get(requestId);
    return row ? decode(row, ChainSchema) : undefined;
  }

  /** Inserts once per request id; a repeat returns the saved chain with `created: false`. */
  function add(chain: ChainInput): { chain: Chain; created: boolean } {
    const { record, json } = encode(ChainSchema, chain);
    return transaction(database, () => {
      const existing = getByRequest(record.requestId);
      if (existing) {
        if (existing.projectId !== record.projectId) fail("conflict", "This request id was already used for a different take.");
        return { chain: existing, created: false };
      }
      database
        .prepare("INSERT INTO chains(id, project_id, request_id, status, data) VALUES (?, ?, ?, ?, ?)")
        .run(record.id, record.projectId, record.requestId, record.status, json);
      return { chain: record, created: true };
    });
  }

  /** Saves `next` only if the stored chain is still at `next.revision - 1`. Returns false when another step won. */
  function update(next: Chain): boolean {
    const { record, json } = encode(ChainSchema, next);
    const result = database
      .prepare("UPDATE chains SET data = ?, status = ? WHERE id = ? AND json_extract(data, '$.revision') = ?")
      .run(json, record.status, record.id, record.revision - 1);
    return result.changes > 0;
  }

  function listByProject(projectId: string): Chain[] {
    return decodeAll(database.prepare("SELECT data FROM chains WHERE project_id = ? ORDER BY json_extract(data, '$.createdAt'), rowid").all(projectId), ChainSchema);
  }

  /** Chains to resume after a restart: running or stitching, oldest first. Paused chains wait for a person. */
  function listActive(): Chain[] {
    return decodeAll(
      database.prepare("SELECT data FROM chains WHERE status IN ('running', 'stitching') ORDER BY json_extract(data, '$.createdAt'), rowid").all(),
      ChainSchema,
    );
  }

  /** The chain a job is a segment of (its own request or the segment's automatic retry), if any. */
  function forJob(job: { projectId: string; requestId: string }): { chain: Chain; index: number } | undefined {
    for (const chain of listByProject(job.projectId)) {
      const segment = chain.segments.find((entry) => entry.requestId === job.requestId || entry.retryRequestId === job.requestId);
      if (segment) return { chain, index: segment.index };
    }
    return undefined;
  }

  const admitted = database.prepare("SELECT 1 FROM jobs WHERE request_id = ?");

  /** USD every running chain holds for segments whose job is not admitted yet. */
  function outstandingUsd(): number {
    let total = 0;
    for (const chain of decodeAll(database.prepare("SELECT data FROM chains WHERE status = 'running'").all(), ChainSchema)) {
      total += chainHoldUsd(chain, (requestId) => admitted.get(requestId) !== undefined);
    }
    return Math.round(total * 1e6) / 1e6;
  }

  return { get, getRequired, getByRequest, add, update, listByProject, listActive, forJob, outstandingUsd };
}
export type ChainRepository = ReturnType<typeof chainRepository>;
