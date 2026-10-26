/**
 * Atomic output commit: write each output through a temp file and rename, then mark the job
 * completed, insert the asset rows, and attach them to their target in one transaction.
 * If the transaction loses (the job already moved on) or fails, the written files are removed.
 * @packageDocumentation
 */
import { type Asset, type AssetKind, type AssetMime, AssetSchema, type VideoMetadata, extensionFor } from "@/lib/domain/asset";
import { addCandidates } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import { type Job, advanceJob, isTerminal } from "@/lib/domain/job";
import { removeMedia, writeAtomic } from "@/server/media/files";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import type { Store } from "@/server/store";

export interface JobOutputFile {
  bytes: Uint8Array;
  mime: AssetMime;
  kind: AssetKind;
  width: number;
  height: number;
  video?: Omit<VideoMetadata, "posterPath"> & { posterPng: Uint8Array };
}

export interface CommitResult {
  job: Job;
  assets: Asset[];
  committed: boolean;
}

function attachToTarget(store: Store, job: Job, assetIds: string[], now: number): void {
  const target = job.request.target;
  if (target.kind !== "shot") return;
  const content = store.content.get(target.contentId);
  if (!content || !content.shots.some((shot) => shot.beatIndex === target.beatIndex)) return;
  store.content.update(addCandidates(content, target.beatIndex, target.slot, assetIds, now));
}

/**
 * Commits a job's outputs. `job` is the caller's last observed record (normally `retrieving`).
 * Returns `committed: false` with the stored job when another worker already finished it.
 */
export async function commitJobOutputs(
  store: Store,
  job: Job,
  outputs: JobOutputFile[],
  context: { now: number; newId: () => string },
): Promise<CommitResult> {
  if (isTerminal(job)) fail("conflict", "This job already finished.");
  if (outputs.length === 0) fail("provider", "The provider returned no outputs.");
  const written: string[] = [];
  try {
    const assets: Asset[] = [];
    for (const output of outputs) {
      const id = context.newId();
      const relativePath = `media/${id}.${extensionFor(output.mime)}`;
      await writeAtomic(resolveMediaPath(store.dataDir, relativePath), output.bytes);
      written.push(relativePath);
      let video: VideoMetadata | undefined;
      if (output.video) {
        const { posterPng, ...metadata } = output.video;
        const posterPath = `media/${id}-poster.png`;
        await writeAtomic(resolveMediaPath(store.dataDir, posterPath), posterPng);
        written.push(posterPath);
        video = { ...metadata, posterPath };
      }
      const kind = job.request.target.kind === "reference_sheet" && output.kind === "image" ? "sheet" : output.kind;
      assets.push(
        AssetSchema.parse({
          id,
          projectId: job.projectId,
          kind,
          mime: output.mime,
          relativePath,
          width: output.width,
          height: output.height,
          sha256: sha256(output.bytes),
          provenance: {
            source: "generated",
            recipeId: job.recipeId,
            jobId: job.id,
            prompt: job.request.prompt,
            inputs: job.request.inputs.map((input) => ({ assetId: input.assetId, sha256: input.sha256 })),
            mock: job.executor === "mock",
          },
          state: { state: "active" },
          video,
          revision: 0,
          createdAt: context.now,
        }),
      );
    }
    const completed = advanceJob(
      job,
      { status: "completed", outputs: assets.map((asset) => asset.id) },
      context.now,
    );
    const committed = store.transaction(() => {
      if (!store.jobs.commitOutputs(completed, assets)) return false;
      attachToTarget(
        store,
        completed,
        assets.map((asset) => asset.id),
        context.now,
      );
      return true;
    });
    if (!committed) {
      await removeMedia(store.dataDir, written);
      return { job: store.jobs.getRequired(job.id), assets: [], committed: false };
    }
    return { job: completed, assets, committed: true };
  } catch (error) {
    await removeMedia(store.dataDir, written);
    throw error;
  }
}
