/**
 * Renders a frozen export record into a verified MP4 and poster under `exports/`.
 * Sources are read once, hash-checked, and copied into a private work folder, so originals are
 * never touched. Output goes through a temp file and a rename, then ffprobe verification.
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { type Asset, AssetSchema, extensionFor } from "@/lib/domain/asset";
import { EXPORT_FPS, EXPORT_HEIGHT, EXPORT_WIDTH, type ExportRecord } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import { captionFontPath } from "@/server/assembly/captions";
import { type Segment, planAssembly } from "@/server/assembly/graph";
import { ffmpegPath, probeVideo } from "@/server/executors/media";
import { readAssetBytes, removeMedia } from "@/server/media/files";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import { checkVideoTools, verifyVideo } from "@/server/media/video";
import type { Store } from "@/server/store";

const execute = promisify(execFile);

/** Folder under the data directory for per-render scratch space; never referenced by records. */
export const WORK_DIRECTORY = "export-work";

const RENDER_TIMEOUT_MS = 600_000;

const drawtextSupport = new Map<string, Promise<boolean>>();

/** Whether the configured ffmpeg was built with the `drawtext` filter (libfreetype). */
export function supportsDrawtext(): Promise<boolean> {
  const binary = ffmpegPath();
  let known = drawtextSupport.get(binary);
  if (!known) {
    known = execute(binary, ["-hide_banner", "-filters"], { timeout: 10_000, maxBuffer: 2_000_000 })
      .then(({ stdout }) => /\sdrawtext\s/.test(stdout))
      .catch(() => false);
    drawtextSupport.set(binary, known);
  }
  return known;
}

function wantsCaptions(record: ExportRecord): boolean {
  return record.options.captions && record.sources.some((source) => source.onScreenText.trim().length > 0);
}

/**
 * Checks everything a render needs before an export record is saved: ffmpeg and ffprobe, and
 * for captions the font file and the drawtext filter. Returns the caption font path, if used.
 */
export async function preflightRender(options: { captions: boolean; texts: string[] }): Promise<string | undefined> {
  await checkVideoTools();
  if (!options.captions || !options.texts.some((text) => text.trim().length > 0)) return undefined;
  const font = captionFontPath();
  if (!font) {
    fail("invalid", "Captions need the bundled font at assets/fonts/DejaVuSans-Bold.ttf, or CAPTION_FONT_PATH set to a TTF file. Turn captions off to export without them.");
  }
  if (!(await supportsDrawtext())) {
    fail("invalid", "This FFmpeg build has no drawtext filter, so captions cannot be burned in. Install an FFmpeg built with libfreetype, or turn captions off.");
  }
  return font;
}

async function prepareSegment(store: Store, record: ExportRecord, index: number, work: string): Promise<Segment> {
  const source = record.sources[index];
  const beat = `beat ${source.beatIndex}`;
  const asset = store.assets.get(source.assetId);
  if (!asset || asset.state.state === "deleted") fail("invalid", `The approved clip for ${beat} was deleted.`);
  if (asset.sha256 !== source.sha256) fail("conflict", `The clip for ${beat} changed after this export started.`);
  const bytes = await readAssetBytes(store.dataDir, asset);
  const frames = Math.round(source.durationSeconds * EXPORT_FPS);
  const caption = record.options.captions ? source.onScreenText : "";
  let voice: Segment["voice"];
  if (source.voice && !record.options.mute) {
    const take = store.assets.get(source.voice.assetId);
    if (!take || take.state.state === "deleted") fail("invalid", `The approved voice-over for ${beat} was deleted.`);
    if (take.sha256 !== source.voice.sha256) fail("conflict", `The voice-over for ${beat} changed after this export started.`);
    const path = join(work, `${index}-voice.${extensionFor(take.mime)}`);
    await writeFile(path, await readAssetBytes(store.dataDir, take), { flag: "wx" });
    voice = { path, durationSeconds: source.voice.durationSeconds };
  }
  if (asset.mime === "video/mp4") {
    const path = join(work, `${index}.mp4`);
    await writeFile(path, bytes, { flag: "wx" });
    const info = await probeVideo(path).catch(() => fail("invalid", `The clip for ${beat} could not be decoded.`));
    return { source: "video", path, hasAudio: info.hasAudio, frames, caption, width: info.width, height: info.height, speech: source.speech, voice };
  }
  const scale = Math.min(EXPORT_WIDTH / asset.width, EXPORT_HEIGHT / asset.height);
  const density = Math.min(2400, Math.max(1, Math.round(72 * scale)));
  const png = await sharp(bytes, asset.mime === "image/svg+xml" ? { density } : {})
    .png()
    .toBuffer()
    .catch(() => fail("invalid", `The still for ${beat} could not be decoded.`));
  const path = join(work, `${index}.png`);
  await writeFile(path, png, { flag: "wx" });
  return { source: "still", path, hasAudio: false, frames, caption, width: asset.width, height: asset.height, voice };
}

export interface RenderedExport {
  asset: Asset;
  durationSeconds: number;
  filterSummary: string;
  /** Media paths written into the data directory, for cleanup if the commit loses. */
  files: string[];
}

/**
 * Renders and verifies one export. The new asset is not saved; the caller commits it with the
 * finished export record. Throws ServiceError for expected problems and plain errors otherwise.
 */
export async function renderExport(
  store: Store,
  record: ExportRecord,
  context: { now: number; newId: () => string; fontPath?: string },
): Promise<RenderedExport> {
  const root = join(store.dataDir, WORK_DIRECTORY);
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(join(root, `${record.id}-`));
  const written: string[] = [];
  try {
    const segments: Segment[] = [];
    for (let index = 0; index < record.sources.length; index++) segments.push(await prepareSegment(store, record, index, work));
    const output = join(work, "export.mp4");
    const fontPath = wantsCaptions(record) ? context.fontPath : undefined;
    if (wantsCaptions(record) && !fontPath) fail("invalid", "Captions need a font file.");
    const plan = planAssembly(segments, { mute: record.options.mute, fontPath, output });
    await execute(ffmpegPath(), plan.args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 4_000_000 });
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
      projectId: record.projectId,
      kind: "export",
      mime: "video/mp4",
      relativePath,
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      sha256: sha256(bytes),
      provenance: { source: "export", exportId: record.id, contentId: record.contentId },
      state: { state: "active" },
      video: {
        durationSeconds: plan.durationSeconds,
        frameRate: EXPORT_FPS,
        frameCount: plan.totalFrames,
        hasAudio: probed.hasAudio,
        posterPath,
      },
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
