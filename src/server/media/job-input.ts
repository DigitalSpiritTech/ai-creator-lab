/**
 * Reads a job's pinned input images, verifying each still matches the hash in the request snapshot.
 * @packageDocumentation
 */
import { readFile } from "node:fs/promises";
import type { AssetMime } from "@/lib/domain/asset";
import { fail } from "@/lib/domain/failure";
import type { Job } from "@/lib/domain/job";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import type { Store } from "@/server/store";

export interface LoadedJobInput {
  role: string;
  assetId: string;
  mime: AssetMime;
  bytes: Buffer;
}

export async function readJobInputs(store: Store, job: Job): Promise<LoadedJobInput[]> {
  const loaded: LoadedJobInput[] = [];
  for (const input of job.request.inputs) {
    const asset = store.assets.get(input.assetId);
    if (!asset || asset.state.state === "deleted") fail("not_found", "An input image for this job was deleted.");
    const bytes = await readFile(resolveMediaPath(store.dataDir, asset.relativePath));
    if (sha256(bytes) !== input.sha256) {
      fail("storage", "An input image for this job changed on disk. Restore it from your backup.");
    }
    loaded.push({ role: input.role, assetId: asset.id, mime: asset.mime, bytes });
  }
  return loaded;
}
