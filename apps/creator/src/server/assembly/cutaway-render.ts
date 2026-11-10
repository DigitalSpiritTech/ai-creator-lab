/**
 * Renders a frozen take-then-cutaways export record into a verified MP4 and poster under
 * `exports/`, like the component render: sources are hash-checked and copied into a private work
 * folder, the output goes through a temp file and a rename, and ffprobe checks it. Nothing is
 * generated: the take, the windows' clips, and the captions all come from the record.
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AssetSchema } from "@creator-lab/core/domain/asset";
import { EXPORT_FPS, EXPORT_HEIGHT, EXPORT_WIDTH, type ExportRecord } from "@creator-lab/core/domain/content";
import { fail } from "@creator-lab/core/domain/failure";
import { ffmpegPath } from "@creator-lab/executors/media";
import { childEnv } from "@creator-lab/executors/process";
import { type CutawayWindow, type TakeAudio, frameAt, planCutaways } from "@/server/assembly/cutaway";
import { type RenderedExport, WORK_DIRECTORY, prepareSegment } from "@/server/assembly/render";
import { readAssetBytes, removeMedia } from "@/server/media/files";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import { probeVideo, verifyVideo } from "@/server/media/video";
import type { Store } from "@/server/store";

const execute = promisify(execFile);
const RENDER_TIMEOUT_MS = 600_000;

/** Whether the record burns captions: captions on, and at least one cue with text. */
export function cutawayCaptions(record: ExportRecord): boolean {
  return record.options.captions && (record.captionCues ?? []).some((cue) => cue.text.trim().length > 0);
}

/**
 * Renders and verifies one take-then-cutaways export. The new asset is not saved; the caller
 * commits it with the finished record. Throws ServiceError for expected problems.
 */
export async function renderCutawayExport(
  store: Store,
  record: ExportRecord,
  context: { now: number; newId: () => string; fontPath?: string },
): Promise<RenderedExport> {
  if (record.strategy !== "take_cutaways" || !record.take) fail("invalid", "This export is not a recording-with-cutaways export.");
  const root = join(store.dataDir, WORK_DIRECTORY);
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(join(root, `${record.id}-`));
  const written: string[] = [];
  try {
    const takeAsset = store.assets.get(record.take.assetId);
    if (!takeAsset || takeAsset.state.state === "deleted") fail("invalid", "The approved recording was deleted.");
    if (takeAsset.sha256 !== record.take.sha256) fail("conflict", "The recording changed after this export started.");
    const takePath = join(work, "take.mp4");
    await writeFile(takePath, await readAssetBytes(store.dataDir, takeAsset), { flag: "wx" });
    const probe = await probeVideo(takePath).catch(() => fail("invalid", "The recording could not be decoded."));
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const sound = probe.streams.find((stream) => stream.codec_type === "audio");
    if (!video) fail("invalid", "The recording has no picture.");
    // The frame count comes from the recorded length, so the file must still be that long.
    const fileSeconds = Number(video.duration ?? probe.format.duration);
    if (!(Math.abs(fileSeconds - record.take.durationSeconds) <= 0.1)) {
      fail("conflict", `The recording file is ${Number.isFinite(fileSeconds) ? fileSeconds.toFixed(2) : "of unknown length"} s, but this export was made for ${record.take.durationSeconds.toFixed(2)} s. Draft the edit decision list again.`);
    }
    if (!sound && !record.options.mute) fail("invalid", "The recording has no sound; a recording-with-cutaways export keeps its audio.");
    // AAC is copied as it is, so the export's sound is the take's packet for packet.
    const audio: TakeAudio = record.options.mute ? "none" : sound!.codec_name === "aac" ? "copy" : "encode";

    const windows: CutawayWindow[] = [];
    for (let index = 0; index < record.sources.length; index++) {
      const source = record.sources[index];
      if (!source.window) fail("storage", `The window for beat ${source.beatIndex} has no times.`);
      const segment = await prepareSegment(store, record, index, work);
      windows.push({
        beatIndex: source.beatIndex,
        source: segment.source,
        path: segment.path,
        width: segment.width,
        height: segment.height,
        startFrame: frameAt(source.window.start),
        endFrame: frameAt(source.window.end),
      });
    }
    const frames = frameAt(record.take.durationSeconds);
    const fontPath = cutawayCaptions(record) ? context.fontPath : undefined;
    if (cutawayCaptions(record) && !fontPath) fail("invalid", "Captions need a font file.");
    const output = join(work, "export.mp4");
    const plan = planCutaways(
      { path: takePath, frames, width: video.width, height: video.height, audio },
      windows,
      record.options.captions ? (record.captionCues ?? []) : [],
      { fontPath, output },
    );
    await execute(ffmpegPath(), plan.args, { env: childEnv(), timeout: RENDER_TIMEOUT_MS, maxBuffer: 4_000_000 });
    const poster = join(work, "poster.png");
    const probed = await verifyVideo(output, poster, {
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      frameRate: EXPORT_FPS,
      frameCount: plan.totalFrames,
      durationSeconds: plan.durationSeconds,
      requireAudio: !record.options.mute,
    });
    if (record.options.mute && probed.hasAudio) fail("storage", "The muted export still has an audio track.");
    const bytes = await readFile(output);
    const id = context.newId();
    const relativePath = `exports/${id}.mp4`;
    const posterPath = `exports/${id}-poster.png`;
    await rename(poster, resolveMediaPath(store.dataDir, posterPath));
    written.push(posterPath);
    await rename(output, resolveMediaPath(store.dataDir, relativePath));
    written.push(relativePath);
    const asset = AssetSchema.parse({
      id,
      ownerId: store.projects.get(record.projectId)?.ownerId,
      projectId: record.projectId,
      kind: "export",
      mime: "video/mp4",
      relativePath,
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      sha256: sha256(bytes),
      provenance: { source: "export", exportId: record.id, contentId: record.contentId },
      state: { state: "active" },
      video: { durationSeconds: plan.durationSeconds, frameRate: EXPORT_FPS, frameCount: plan.totalFrames, hasAudio: probed.hasAudio, posterPath },
      revision: 0,
      createdAt: context.now,
    });
    return { asset, durationSeconds: plan.durationSeconds, filterSummary: plan.summary, files: [...written] };
  } catch (error) {
    await removeMedia(store.dataDir, written);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
