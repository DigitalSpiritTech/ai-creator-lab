/**
 * Where the data folder lives: `STUDIO_DATA_DIR`, defaulting to `.data` in the working directory.
 * Kept apart from `runtime.ts` so light modules (the request proxy, the auth provider) can find
 * the folder without opening the database.
 * @packageDocumentation
 */
import { resolve } from "node:path";

/** The data directory from `STUDIO_DATA_DIR`, defaulting to `.data` in the working directory. */
export function dataDirectory(): string {
  // Workspace data must never become a bundled application asset.
  return resolve(/* turbopackIgnore: true */ process.env.STUDIO_DATA_DIR || ".data");
}
