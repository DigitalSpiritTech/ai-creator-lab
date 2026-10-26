/**
 * Opens the SQLite database (WAL, foreign keys), runs migrations, and provides
 * transaction and JSON-column helpers shared by the repositories.
 * @packageDocumentation
 */
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ServiceError, fail } from "@/lib/domain/failure";
import { MIGRATIONS, SCHEMA_VERSION } from "@/server/store/migrations";

const VersionRowSchema = z.object({ user_version: z.number().int() });
const DataRowSchema = z.object({ data: z.string() });

export function schemaVersion(database: DatabaseSync): number {
  return VersionRowSchema.parse(database.prepare("PRAGMA user_version").get()).user_version;
}

/** Applies pending migrations in one immediate transaction. Refuses a database from a newer app. */
export function migrate(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = schemaVersion(database);
    if (version > SCHEMA_VERSION) {
      throw new ServiceError(
        "storage",
        "This data directory was saved by a newer version of AI Creator Lab. Update the app before opening it.",
      );
    }
    for (let next = version + 1; next <= SCHEMA_VERSION; next += 1) {
      database.exec(MIGRATIONS[next - 1]);
      database.exec(`PRAGMA user_version = ${next}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(file: string): DatabaseSync {
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

let savepoints = 0;

/**
 * Runs synchronous work in an immediate transaction, or in a savepoint when one is already open,
 * so repository methods compose into larger atomic operations.
 */
export function transaction<T>(database: DatabaseSync, work: () => T): T {
  if (database.isTransaction) {
    savepoints += 1;
    const name = `nested_${savepoints}`;
    database.exec(`SAVEPOINT ${name}`);
    try {
      const result = work();
      database.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      database.exec(`ROLLBACK TO ${name}`);
      database.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Parses a `data` JSON column through its contract. */
export function decode<T>(row: unknown, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(DataRowSchema.parse(row).data));
}

export function decodeAll<T>(rows: unknown[], schema: z.ZodType<T>): T[] {
  return rows.map((row) => decode(row, schema));
}

/** Validates a record through its contract and serializes it for a `data` column. */
export function encode<T>(schema: z.ZodType<T>, value: T): { record: T; json: string } {
  const record = schema.parse(value);
  return { record, json: JSON.stringify(record) };
}

/**
 * Writes the next revision of a record only if the stored one is exactly one behind. Writing a
 * record identical to the stored one is a no-op, so unchanged transitions and retries succeed.
 * `table`, `where`, and `field` are fixed identifiers from repository code, never user input.
 */
export function writeRevision(
  database: DatabaseSync,
  table: string,
  where: string,
  keys: string[],
  json: string,
  revision: number,
  field = "revision",
): void {
  const result = database
    .prepare(`UPDATE ${table} SET data = ? WHERE ${where} AND json_extract(data, '$.${field}') = ?`)
    .run(json, ...keys, revision - 1);
  if (result.changes > 0) return;
  const stored = database.prepare(`SELECT data FROM ${table} WHERE ${where}`).get(...keys);
  if (stored && DataRowSchema.parse(stored).data === json) return;
  fail("conflict", "This changed in another view. Refresh and try again.");
}
