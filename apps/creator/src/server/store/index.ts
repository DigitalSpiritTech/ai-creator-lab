/**
 * The local store: one SQLite database plus managed media folders under a data directory.
 * @packageDocumentation
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MEDIA_DIRECTORIES } from "@/server/media/paths";
import { assetRepository } from "@/server/store/assets";
import { backendRepository } from "@/server/store/backends";
import { budgetRepository } from "@/server/store/budget";
import { chainRepository } from "@/server/store/chains";
import { openDatabase, transaction } from "@/server/store/connection";
import { contentRepository } from "@/server/store/content";
import { documentRepository } from "@/server/store/documents";
import { jobRepository } from "@/server/store/jobs";
import { libraryRepository } from "@/server/store/library";
import { pieceRepository } from "@/server/store/pieces";
import { preferencesRepository } from "@/server/store/preferences";
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
  /** Content pieces of plugin content types: named slots plus a plugin-owned body. */
  readonly pieces: ReturnType<typeof pieceRepository>;
  /** Version history of the brief, character bibles, and product cards. */
  readonly documents: ReturnType<typeof documentRepository>;
  /** Per-period budget extensions ("add to this month"). */
  readonly budget: ReturnType<typeof budgetRepository>;
  /** Servers recipes run on (Comfy Cloud, Router, self-hosted ComfyUI, deployments). */
  readonly backends: ReturnType<typeof backendRepository>;
  /** Per-project recipe preferences by capability. */
  readonly preferences: ReturnType<typeof preferencesRepository>;
  /** Chained takes: the plan, the job behind each segment, and the stitched result. */
  readonly chains: ReturnType<typeof chainRepository>;
  /** What the spend policy counts as held beyond job reservations (chain segments not admitted yet). */
  readonly holds: { outstandingUsd(): number };
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
  const chains = chainRepository(database);
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
    pieces: pieceRepository(database),
    documents: documentRepository(database),
    budget: budgetRepository(database),
    backends: backendRepository(database),
    preferences: preferencesRepository(database),
    chains,
    holds: { outstandingUsd: chains.outstandingUsd },
    transaction: (work) => transaction(database, work),
    close: () => database.close(),
  };
}
