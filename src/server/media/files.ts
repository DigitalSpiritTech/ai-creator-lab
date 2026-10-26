/**
 * Atomic, hash-verified file IO for managed media.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Asset } from "@/lib/domain/asset";
import { fail } from "@/lib/domain/failure";
import { resolveMediaPath, sha256 } from "@/server/media/paths";

/** Writes a complete file through a temporary sibling and a rename, so readers never see partial bytes. */
export async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Reads an asset's file and checks it still matches the recorded hash. */
export async function readAssetBytes(dataDir: string, asset: Asset): Promise<Buffer> {
  if (asset.state.state === "deleted") fail("not_found", "This asset was deleted.");
  const bytes = await readFile(resolveMediaPath(dataDir, asset.relativePath));
  if (sha256(bytes) !== asset.sha256) fail("storage", "This file changed on disk. Restore it from your backup.");
  return bytes;
}

/** Removes managed files, ignoring ones already gone. */
export async function removeMedia(dataDir: string, relativePaths: string[]): Promise<void> {
  for (const relativePath of relativePaths) await rm(resolveMediaPath(dataDir, relativePath), { force: true });
}
