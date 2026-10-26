/**
 * The local store: one SQLite database plus managed media folders under a data directory.
 * @packageDocumentation
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MEDIA_DIRECTORIES } from "@/server/media/paths";
import { assetRepository } from "@/server/store/assets";
import { openDatabase, transaction } from "@/server/store/connection";
import { contentRepository } from "@/server/store/content";
import { jobRepository } from "@/server/store/jobs";
import { libraryRepository } from "@/server/store/library";
import { projectRepository } from "@/server/store/projects";
import { scriptRepository } from "@/server/store/scripts";
import { workspaceRepository } from "@/server/store/workspace";

export { SCHEMA_VERSION } from "@/server/store/migrations";
export type { AssetFilter } from "@/server/store/assets";

export const DATABASE_FILE = "studio.sqlite";

export interface Store {
  /** Absolute data directory; media paths in records are relative to it. */
  readonly dataDir: string;
  readonly database: DatabaseSync;
  readonly workspace: ReturnType<typeof workspaceRepository>;
  readonly projects: ReturnType<typeof projectRepository>;
  readonly library: ReturnType<typeof libraryRepository>;
  readonly assets: ReturnType<typeof assetRepository>;
  readonly jobs: ReturnType<typeof jobRepository>;
  readonly scripts: ReturnType<typeof scriptRepository>;
  readonly content: ReturnType<typeof contentRepository>;
  /** Runs synchronous store work atomically; nested calls become savepoints. */
  transaction<T>(work: () => T): T;
  close(): void;
}

/**
 * Opens (creating if needed) the data directory, its media folders, and the database, and
 * applies migrations. The caller owns the returned store and must close it.
 */
export function openStore(dataDir: string): Store {
  const root = resolve(dataDir);
  for (const directory of MEDIA_DIRECTORIES) mkdirSync(join(root, directory), { recursive: true });
  const database = openDatabase(join(root, DATABASE_FILE));
  return {
    dataDir: root,
    database,
    workspace: workspaceRepository(database),
    projects: projectRepository(database),
    library: libraryRepository(database),
    assets: assetRepository(database),
    jobs: jobRepository(database),
    scripts: scriptRepository(database),
    content: contentRepository(database),
    transaction: (work) => transaction(database, work),
    close: () => database.close(),
  };
}
