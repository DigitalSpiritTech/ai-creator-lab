/**
 * Budget extensions: money a person added to one budget period with "add to this month". One row
 * per click, keyed by a client-chosen id so a repeated click adds the money once.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { type BudgetExtension, BudgetExtensionSchema } from "@creator-lab/core/domain/spend";
import { decode, decodeAll, encode, transaction } from "@/server/store/connection";

export function budgetRepository(database: DatabaseSync) {
  function get(id: string): BudgetExtension | undefined {
    const row = database.prepare("SELECT data FROM budget_extensions WHERE id = ?").get(id);
    return row ? decode(row, BudgetExtensionSchema) : undefined;
  }

  /** A period's extensions, oldest first. */
  function listForPeriod(periodKey: string): BudgetExtension[] {
    const rows = database
      .prepare("SELECT data FROM budget_extensions WHERE period_key = ? ORDER BY json_extract(data, '$.createdAt'), rowid")
      .all(periodKey);
    return decodeAll(rows, BudgetExtensionSchema);
  }

  /** Saves an extension once per id; a repeat returns the saved one with `created: false`. */
  function add(extension: BudgetExtension): { extension: BudgetExtension; created: boolean } {
    const { record, json } = encode(BudgetExtensionSchema, extension);
    return transaction(database, () => {
      const existing = get(record.id);
      if (existing) return { extension: existing, created: false };
      database.prepare("INSERT INTO budget_extensions(id, period_key, data) VALUES (?, ?, ?)").run(record.id, record.periodKey, json);
      return { extension: record, created: true };
    });
  }

  return { get, listForPeriod, add };
}
export type BudgetRepository = ReturnType<typeof budgetRepository>;
