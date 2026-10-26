/**
 * Server runtime: resolves the data directory and owns the one store per process.
 * @packageDocumentation
 */
import "server-only";
import { resolve } from "node:path";
import { z } from "zod";
import { toFailure } from "@/lib/domain/failure";
import { type Store, openStore } from "@/server/store";
import { recoveryEnabled, startRecoveryOnce } from "@/server/tools/recovery";

const holder = globalThis as typeof globalThis & { __creatorLabStore?: Store };

/** The data directory from `STUDIO_DATA_DIR`, defaulting to `.data` in the working directory. */
export function dataDirectory(): string {
  // Workspace data must never become a bundled application asset.
  return resolve(/* turbopackIgnore: true */ process.env.STUDIO_DATA_DIR || ".data");
}

/**
 * Opens the store on first use (creating the data directory) and reuses it for the process. The
 * first open also starts restart recovery in the background, as a fallback for `instrumentation.ts`.
 */
export function getStore(): Store {
  if (!holder.__creatorLabStore) {
    holder.__creatorLabStore = openStore(dataDirectory());
    if (recoveryEnabled()) void startRecoveryOnce(holder.__creatorLabStore);
  }
  return holder.__creatorLabStore;
}

/**
 * Runs an operation against the process store. HTTP responses and validation errors pass
 * through; anything else becomes a safe ServiceFailure.
 */
export async function withStore<T>(operation: (store: Store) => T | Promise<T>): Promise<T> {
  try {
    return await operation(getStore());
  } catch (error) {
    if (error instanceof Response || error instanceof z.ZodError) throw error;
    throw toFailure(error);
  }
}

/** Closes the process store, for shutdown and tests. */
export function closeStore(): void {
  holder.__creatorLabStore?.close();
  holder.__creatorLabStore = undefined;
}
