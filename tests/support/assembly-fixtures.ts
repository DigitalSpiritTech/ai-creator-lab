/**
 * Synthetic media for assembly tests: solid-color and test-pattern clips made by ffmpeg's lavfi
 * sources, imported as assets and approved on a content piece. No providers, no network.
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import sharp from "sharp";
import { type Asset, AssetSchema } from "@/lib/domain/asset";
import { type ContentPiece, addCandidates, approveCandidate, planShots } from "@/lib/domain/content";
import { type BeatInput, createScript } from "@/lib/domain/script";
import { probeVideo } from "@/server/executors/media";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import type { Store } from "@/server/store";
import { ridgelineBeats } from "./domain-fixtures";

const execute = promisify(execFile);

export function ffmpeg(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

export interface ClipSpec {
  /** A lavfi color name, or "testsrc" for the moving test pattern. */
  color: string;
  width: number;
  height: number;
  rate: number;
  seconds: number;
  audio: boolean;
}

function upload(name: string, bytes: Uint8Array) {
  return { source: "upload" as const, name, originalSha256: sha256(bytes) };
}

/** Renders a synthetic H.264 clip (with a 440 Hz AAC tone when `audio`) and saves it as a video asset. */
export async function importClip(store: Store, projectId: string, spec: ClipSpec, now: number): Promise<Asset> {
  const id = randomUUID();
  const relativePath = `media/${id}.mp4`;
  const path = resolveMediaPath(store.dataDir, relativePath);
  const video =
    spec.color === "testsrc"
      ? `testsrc=size=${spec.width}x${spec.height}:rate=${spec.rate}:duration=${spec.seconds}`
      : `color=c=${spec.color}:s=${spec.width}x${spec.height}:r=${spec.rate}:d=${spec.seconds}`;
  const audio = spec.audio
    ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${spec.seconds}`, "-c:a", "aac", "-b:a", "96k"]
    : ["-an"];
  await execute(
    ffmpeg(),
    ["-nostdin", "-v", "error", "-f", "lavfi", "-i", video, ...audio, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", String(spec.seconds), path],
    { timeout: 30_000 },
  );
  const bytes = await readFile(path);
  const info = await probeVideo(path);
  return store.assets.insert(
    AssetSchema.parse({
      id,
      projectId,
      kind: "video",
      mime: "video/mp4",
      relativePath,
      width: info.width,
      height: info.height,
      sha256: sha256(bytes),
      provenance: upload(`${spec.color}.mp4`, bytes),
      state: { state: "active" },
      video: { durationSeconds: info.durationSeconds, frameRate: info.fps, frameCount: info.frames, hasAudio: info.hasAudio },
      revision: 0,
      createdAt: now,
    }),
  );
}

/** Saves a small solid PNG as an image asset (a beat's still, or a still used as its clip). */
export async function importStill(store: Store, projectId: string, color: string, now: number): Promise<Asset> {
  const id = randomUUID();
  const relativePath = `media/${id}.png`;
  const bytes = await sharp({ create: { width: 90, height: 160, channels: 3, background: color } }).png().toBuffer();
  await sharp(bytes).toFile(resolveMediaPath(store.dataDir, relativePath));
  return store.assets.insert(
    AssetSchema.parse({
      id,
      projectId,
      kind: "image",
      mime: "image/png",
      relativePath,
      width: 90,
      height: 160,
      sha256: sha256(bytes),
      provenance: upload(`${color}.png`, bytes),
      state: { state: "active" },
      revision: 0,
      createdAt: now,
    }),
  );
}

/** The first `count` example beats with chosen on-screen text and lengths. */
export function beatsWith(texts: string[], seconds: number[] = []): BeatInput[] {
  const base = ridgelineBeats();
  return texts.map((onScreenText, index) => ({
    ...base[index % base.length],
    onScreenText,
    durationSeconds: seconds[index] ?? 5,
  }));
}

/**
 * Saves a script and an Ad whose shots have an approved still and the given clips approved, in
 * beat order. Pass `null` for a beat to leave its clip unapproved.
 */
export async function approvedContent(
  store: Store,
  projectId: string,
  beats: BeatInput[],
  clips: (Asset | null)[],
  now: () => number,
): Promise<ContentPiece> {
  const script = store.scripts.create(createScript(randomUUID(), projectId, "Synthetic cut", beats, now()));
  let content = planShots(randomUUID(), script, "Synthetic ad", now(), randomUUID);
  const still = await importStill(store, projectId, "#808080", now());
  for (const [index, clip] of clips.entries()) {
    const beat = index + 1;
    content = addCandidates(content, beat, "still", [still.id], now());
    content = approveCandidate(content, beat, "still", still.id, now()).content;
    if (!clip) continue;
    content = addCandidates(content, beat, "clip", [clip.id], now());
    content = approveCandidate(content, beat, "clip", clip.id, now()).content;
  }
  return store.content.create(content);
}

/** One decoded RGB frame (or a crop of it) at `seconds`. */
export async function frameAt(path: string, seconds: number, crop?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const filter = crop ? ["-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : [];
  const { stdout } = await execute(
    ffmpeg(),
    ["-v", "error", "-ss", String(seconds), "-i", path, "-frames:v", "1", ...filter, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 16_000_000, timeout: 30_000 },
  );
  return stdout;
}

/** Mean RGB of a buffer of rgb24 pixels. */
export function meanColor(pixels: Buffer): [number, number, number] {
  const sums = [0, 0, 0];
  for (let index = 0; index < pixels.length; index += 3) {
    sums[0] += pixels[index];
    sums[1] += pixels[index + 1];
    sums[2] += pixels[index + 2];
  }
  const count = pixels.length / 3;
  return [sums[0] / count, sums[1] / count, sums[2] / count];
}

/** Mean absolute per-channel difference between two equal-length frames. */
export function pixelDifference(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) throw new Error("Frames differ in size.");
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
  return total / a.length;
}

/** RMS of the first audio stream between two times, decoded as mono 48 kHz floats. */
export async function audioRms(path: string, start: number, end: number): Promise<number> {
  const { stdout } = await execute(
    ffmpeg(),
    ["-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
    { encoding: "buffer", maxBuffer: 64_000_000, timeout: 30_000 },
  );
  let sum = 0;
  let count = 0;
  for (let sample = Math.round(start * 48_000); sample < Math.round(end * 48_000) && (sample + 1) * 4 <= stdout.length; sample++) {
    const value = stdout.readFloatLE(sample * 4);
    sum += value * value;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}
