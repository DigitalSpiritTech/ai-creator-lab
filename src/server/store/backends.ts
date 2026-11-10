/**
 * Backends: one row per server recipes can run on, with its last probe and verified runs.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { type Backend, BackendSchema } from "@/lib/catalog/backends";
import { decode, decodeAll, encode, transaction } from "@/server/store/connection";

export function backendRepository(database: DatabaseSync) {
  function get(id: string): Backend | undefined {
    const row = database.prepare("SELECT data FROM backends WHERE id = ?").get(id);
    return row ? decode(row, BackendSchema) : undefined;
  }

  /** Every backend, oldest first. */
  function list(): Backend[] {
    const rows = database.prepare("SELECT data FROM backends ORDER BY json_extract(data, '$.createdAt'), rowid").all();
    return decodeAll(rows, BackendSchema);
  }

  /** Inserts or replaces one backend. */
  function put(backend: Backend): Backend {
    const { record, json } = encode(BackendSchema, backend);
    database.prepare("INSERT INTO backends(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(record.id, json);
    return record;
  }

  /** Reads, changes, and saves one backend atomically; undefined when it does not exist. */
  function update(id: string, change: (backend: Backend) => Backend): Backend | undefined {
    return transaction(database, () => {
      const current = get(id);
      return current ? put(change(current)) : undefined;
    });
  }

  function remove(id: string): boolean {
    return Number(database.prepare("DELETE FROM backends WHERE id = ?").run(id).changes) > 0;
  }

  /** Marks one backend as the default for workflows and clears the flag everywhere else. */
  function setDefault(id: string, now: number): Backend | undefined {
    return transaction(database, () => {
      const target = get(id);
      if (!target) return undefined;
      for (const backend of list()) {
        if (backend.default && backend.id !== id) put({ ...backend, default: false, updatedAt: now });
      }
      return put({ ...target, default: true, updatedAt: now });
    });
  }

  return { get, list, put, update, remove, setDefault };
}
export type BackendRepository = ReturnType<typeof backendRepository>;
