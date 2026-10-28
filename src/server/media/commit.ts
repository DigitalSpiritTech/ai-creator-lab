/**
 * Atomic output commit: the job's terminal state, its asset rows, and the attachment of the new
 * assets to their target (a shot's candidates) are written in one transaction. Outputs are either
 * bytes (written here through a temp file and rename) or files an executor already retrieved and
 * verified into `media/` (checked against their hash and used in place).
 * @packageDocumentation
 */
import { readFile } from "node:fs/promises";
import { capabilityMedia } from "@/lib/catalog";
import { type Asset, type AssetKind, type AssetMime, AssetSchema, type AudioMetadata, type VideoMetadata, extensionFor, isAudioMime } from "@/lib/domain/asset";
import { MediaPathSchema } from "@/lib/domain/common";
import { addCandidates } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import { type Job, type RetrievedFile, advanceJob, isTerminal } from "@/lib/domain/job";
import { removeMedia, writeAtomic } from "@/server/media/files";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import type { Store } from "@/server/store";

/** Output bytes to write under `media/<assetId>.<ext>`. */
export interface BytesOutput {
  bytes: Uint8Array;
  mime: AssetMime;
  kind: AssetKind;
  width: number;
  height: number;
  video?: Omit<VideoMetadata, "posterPath"> & { posterPng?: Uint8Array };
  audio?: AudioMetadata;
}

/** A file an executor retrieved into `media/`, with an optional extracted poster beside it. */
export interface StagedOutput {
  retrieved: RetrievedFile;
  posterPath?: string;
}

export type JobOutputFile = BytesOutput | StagedOutput;

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

/** Asset kind for a retrieved file: MP4 is video, an SVG plate for a video capability is a storyboard, a sheet target's image is a sheet. */
export function assetKindFor(job: Job, mime: AssetMime): AssetKind {
  if (mime === "video/mp4") return "video";
  if (isAudioMime(mime)) return "audio";
  if (mime === "image/svg+xml" && capabilityMedia(job.capability) === "video") return "storyboard";
  return job.request.target.kind === "reference_sheet" ? "sheet" : "image";
}

/** Copies an existing file's identity into a new asset row without moving it. */
async function stagedAsset(store: Store, job: Job, output: StagedOutput): Promise<Omit<Asset, "id" | "provenance" | "state" | "revision" | "createdAt">> {
  const file = output.retrieved;
  const relativePath = MediaPathSchema.parse(file.relativePath);
  const bytes = await readFile(resolveMediaPath(store.dataDir, relativePath));
  if (sha256(bytes) !== file.sha256) fail("storage", "A retrieved output changed on disk before it was saved.");
  const video: VideoMetadata | undefined = file.video
    ? {
        durationSeconds: file.video.durationSeconds,
        frameRate: file.video.fps,
        frameCount: file.video.frames,
        hasAudio: file.video.hasAudio,
        posterPath: output.posterPath,
      }
    : undefined;
  const audio: AudioMetadata | undefined = file.audio ? { ...file.audio, transcript: job.request.input.prompt.slice(0, 2000) } : undefined;
  return {
    projectId: job.projectId,
    kind: assetKindFor(job, file.mime),
    mime: file.mime,
    relativePath,
    width: file.width,
    height: file.height,
    sha256: file.sha256,
    video,
    audio,
  };
}

/**
 * Commits a job's outputs. `job` is the caller's last observed record (normally `retrieving`).
 * Returns `committed: false` with the stored job when another worker already finished it.
 * Files written here are removed if the commit loses or fails; staged files are left for a retry.
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
      let fields: Omit<Asset, "id" | "provenance" | "state" | "revision" | "createdAt">;
      if ("retrieved" in output) {
        fields = await stagedAsset(store, job, output);
      } else {
        const relativePath = `media/${id}.${extensionFor(output.mime)}`;
        await writeAtomic(resolveMediaPath(store.dataDir, relativePath), output.bytes);
        written.push(relativePath);
        let video: VideoMetadata | undefined;
        if (output.video) {
          const { posterPng, ...metadata } = output.video;
          let posterPath: string | undefined;
          if (posterPng) {
            posterPath = `media/${id}-poster.png`;
            await writeAtomic(resolveMediaPath(store.dataDir, posterPath), posterPng);
            written.push(posterPath);
          }
          video = { ...metadata, posterPath };
        }
        const kind = job.request.target.kind === "reference_sheet" && output.kind === "image" ? "sheet" : output.kind;
        fields = {
          projectId: job.projectId,
          kind,
          mime: output.mime,
          relativePath,
          width: output.width,
          height: output.height,
          sha256: sha256(output.bytes),
          video,
          audio: output.audio,
        };
      }
      assets.push(
        AssetSchema.parse({
          id,
          ...fields,
          provenance: {
            source: "generated",
            recipeId: job.recipeId,
            jobId: job.id,
            prompt: job.request.input.prompt,
            inputs: job.request.inputs.map((input) => ({ assetId: input.assetId, sha256: input.sha256 })),
            mock: job.executor === "mock",
          },
          state: { state: "active" },
          revision: 0,
          createdAt: context.now,
        }),
      );
    }
    const completed = advanceJob(job, { status: "completed", outputs: assets.map((asset) => asset.id) }, context.now);
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
