/**
 * Audio assets: uploaded voice recordings and voice samples lifted from a clip's audio track.
 * Both are checked with ffprobe, rejected when silent, and stored under `references/`.
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Asset, AssetSchema } from "@/lib/domain/asset";
import { fail } from "@/lib/domain/failure";
import { ffmpegPath, meanVolumeDb, probeAudio, type AudioInfo } from "@/server/executors/media";
import { removeMedia, writeAtomic } from "@/server/media/files";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import type { Store } from "@/server/store";

const execute = promisify(execFile);

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Voice samples are trimmed to this; cloning needs a few seconds, not a monologue. */
export const MAX_SAMPLE_SECONDS = 30;
const SILENT_DB = -50;

export interface AudioImport {
  projectId: string | null;
  name: string;
  bytes: Uint8Array;
}

/**
 * Reads an uploaded recording. FLAC, MP3, and WAV are kept as they are; anything else ffmpeg can
 * decode (M4A, AAC, OGG, a video's audio) is converted to FLAC.
 */
async function normalizeAudio(bytes: Uint8Array): Promise<{ bytes: Buffer; info: AudioInfo }> {
  const scratch = await mkdtemp(join(tmpdir(), "acl-audio-"));
  try {
    const source = join(scratch, "upload");
    await writeFile(source, bytes);
    let path = source;
    let info = await probeAudio(source).catch(() => undefined);
    if (!info) {
      const converted = join(scratch, "converted.flac");
      await execute(ffmpegPath(), ["-nostdin", "-v", "error", "-i", source, "-vn", "-c:a", "flac", converted], { timeout: 120_000, maxBuffer: 1_000_000 }).catch(() => {
        fail("invalid", "Use an audio recording ffmpeg can read: FLAC, WAV, MP3, M4A, or OGG.");
      });
      path = converted;
      info = await probeAudio(converted).catch(() => fail("invalid", "The recording could not be read as audio."));
    }
    if (info.durationSeconds > MAX_SAMPLE_SECONDS) {
      const trimmed = join(scratch, "trimmed.flac");
      await execute(ffmpegPath(), ["-nostdin", "-v", "error", "-i", path, "-vn", "-t", String(MAX_SAMPLE_SECONDS), "-c:a", "flac", trimmed], { timeout: 120_000, maxBuffer: 1_000_000 });
      path = trimmed;
      info = await probeAudio(trimmed);
    }
    const loudness = await meanVolumeDb(path).catch(() => fail("invalid", "The recording's loudness could not be measured. Check that ffmpeg is installed."));
    if (loudness < SILENT_DB) fail("invalid", "The recording is silent. Record a few sentences in a quiet room and try again.");
    return { bytes: await readFile(path), info };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function audioExtension(mime: AudioInfo["mime"]): string {
  return mime === "audio/flac" ? "flac" : mime === "audio/mpeg" ? "mp3" : "wav";
}

/** Saves an uploaded recording once per project (or once in the Library when `projectId` is null). */
export async function importAudio(store: Store, input: AudioImport, context: { now: number; newId: () => string }): Promise<Asset> {
  if (input.projectId !== null) store.projects.getRequired(input.projectId);
  if (input.bytes.length === 0 || input.bytes.length > MAX_AUDIO_BYTES) fail("invalid", "Choose a recording up to 25 MB.");
  const originalSha256 = sha256(input.bytes);
  const existing = store.assets.findUpload(input.projectId, originalSha256);
  if (existing) return existing;
  const { bytes, info } = await normalizeAudio(input.bytes);
  const id = context.newId();
  const asset = AssetSchema.parse({
    id,
    projectId: input.projectId,
    kind: "audio",
    mime: info.mime,
    relativePath: `references/${id}.${audioExtension(info.mime)}`,
    width: 0,
    height: 0,
    sha256: sha256(bytes),
    provenance: { source: "upload", name: input.name, originalSha256 },
    state: { state: "active" },
    audio: { durationSeconds: info.durationSeconds, codec: info.codec },
    revision: 0,
    createdAt: context.now,
  });
  await writeAtomic(resolveMediaPath(store.dataDir, asset.relativePath), bytes);
  try {
    return store.assets.insert(asset);
  } catch (error) {
    await removeMedia(store.dataDir, [asset.relativePath]);
    throw error;
  }
}

/**
 * Lifts a clip's audio track into a FLAC voice sample asset, with the clip's spoken line as the
 * transcript so a cloning model can align it. Reuses an earlier sample of the same clip.
 */
export async function extractVoiceSample(
  store: Store,
  clip: Asset,
  transcript: string | undefined,
  context: { now: number; newId: () => string },
): Promise<Asset> {
  if (clip.kind !== "video" || !clip.video?.hasAudio) fail("invalid", "A voice sample needs a clip with sound.");
  if (clip.state.state !== "active") fail("invalid", "Restore the clip before taking its audio.");
  const existing = store.assets
    .list({ projectId: clip.projectId ?? undefined, kind: "audio", state: "active" })
    .find((asset) => asset.provenance.source === "derived" && asset.provenance.fromAssetId === clip.id);
  if (existing) return existing;
  const scratch = await mkdtemp(join(tmpdir(), "acl-voice-"));
  try {
    const output = join(scratch, "voice.flac");
    await execute(
      ffmpegPath(),
      ["-nostdin", "-v", "error", "-i", resolveMediaPath(store.dataDir, clip.relativePath), "-vn", "-t", String(MAX_SAMPLE_SECONDS), "-c:a", "flac", output],
      { timeout: 120_000, maxBuffer: 1_000_000 },
    ).catch(() => fail("invalid", "The clip's audio could not be extracted. Check that ffmpeg is installed."));
    const info = await probeAudio(output).catch(() => fail("invalid", "The clip's audio could not be read."));
    const loudness = await meanVolumeDb(output).catch(() => fail("invalid", "The clip's loudness could not be measured."));
    if (loudness < SILENT_DB) fail("invalid", "This clip's audio is silent, so it cannot be a voice sample. Use another talking clip or upload a recording.");
    const bytes = await readFile(output);
    const id = context.newId();
    const asset = AssetSchema.parse({
      id,
      projectId: clip.projectId,
      kind: "audio",
      mime: "audio/flac",
      relativePath: `references/${id}.flac`,
      width: 0,
      height: 0,
      sha256: sha256(bytes),
      provenance: { source: "derived", fromAssetId: clip.id, method: "audio_track" },
      state: { state: "active" },
      audio: { durationSeconds: info.durationSeconds, codec: info.codec, ...(transcript ? { transcript } : {}) },
      revision: 0,
      createdAt: context.now,
    });
    await writeAtomic(resolveMediaPath(store.dataDir, asset.relativePath), bytes);
    try {
      return store.assets.insert(asset);
    } catch (error) {
      await removeMedia(store.dataDir, [asset.relativePath]);
      throw error;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
