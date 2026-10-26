/**
 * Output verification and atomic commits: temp file, decode check, rename, SHA-256.
 * ffprobe and ffmpeg come from PATH unless FFPROBE_PATH or FFMPEG_PATH name them.
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import { jobError, ExecutorFailure } from "@/server/executors/jobs";
import type { RetrieveDestination, RetrievedFile } from "@/server/executors/types";

const execute = promisify(execFile);

export function ffprobePath(): string {
  return process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Absolute and relative paths for one output, refusing folders that escape the root. */
export function outputLocation(destination: RetrieveDestination, name: string): { absolute: string; relative: string } {
  if (!/^[\w-]+(\/[\w-]+)*$/.test(destination.folder)) throw new ExecutorFailure(jobError("invalid", "The output folder must be a plain relative path."));
  const root = resolve(destination.root);
  const absolute = resolve(root, destination.folder, name);
  if (!absolute.startsWith(root + sep)) throw new ExecutorFailure(jobError("invalid", "The output folder must stay inside the data directory."));
  return { absolute, relative: `${destination.folder}/${name}` };
}

/** A temp path beside the final location so the rename stays on one filesystem. */
export async function tempBeside(absolute: string): Promise<string> {
  await mkdir(dirname(absolute), { recursive: true });
  return `${absolute}.${randomUUID()}.tmp`;
}

export interface ImageInfo {
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

/** Decodes an image fully and reports its format and size. */
export async function probeImage(path: string): Promise<ImageInfo> {
  const image = sharp(path, { failOn: "warning", limitInputPixels: 40_000_000 });
  const info = await image.metadata();
  await image.stats();
  const mime = info.format === "png" ? "image/png" : info.format === "jpeg" ? "image/jpeg" : info.format === "webp" ? "image/webp" : undefined;
  if (!mime || !info.width || !info.height || (info.pages ?? 1) !== 1) throw new Error("Unsupported image output.");
  return { mime, width: info.width, height: info.height };
}

const ProbeSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      avg_frame_rate: z.string().optional(),
      nb_read_frames: z.string().optional(),
      nb_frames: z.string().optional(),
      duration: z.string().optional(),
    }),
  ),
  format: z.object({ duration: z.string().optional(), format_name: z.string().optional() }),
});

export interface VideoInfo {
  codec: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  durationSeconds: number;
  hasAudio: boolean;
}

/** Probes an MP4 (counting decoded frames) and decodes it once end to end. */
export async function probeVideo(path: string): Promise<VideoInfo> {
  const { stdout } = await execute(ffprobePath(), ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path], {
    timeout: 60_000,
    maxBuffer: 1_000_000,
  });
  const probe = ProbeSchema.parse(JSON.parse(stdout));
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  if (!video?.width || !video.height || !video.codec_name) throw new Error("No video stream.");
  const [numerator, denominator] = (video.avg_frame_rate ?? "0/0").split("/").map(Number);
  const fps = denominator ? numerator / denominator : 0;
  const frames = Number(video.nb_read_frames ?? video.nb_frames);
  const durationSeconds = Number(video.duration ?? probe.format.duration);
  if (!Number.isInteger(frames) || frames <= 0 || !(fps > 0) || !(durationSeconds > 0)) throw new Error("Unreadable video timing.");
  await execute(ffmpegPath(), ["-nostdin", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"], { timeout: 120_000, maxBuffer: 1_000_000 });
  return { codec: video.codec_name, width: video.width, height: video.height, frames, fps, durationSeconds, hasAudio: !!audio };
}

/** What a finished output must look like; unset fields are not checked. */
export interface OutputExpectation {
  media: "image" | "video";
  width?: number;
  height?: number;
  /** Aspect ratio (width / height) within 3 percent, for providers that pick their own pixel size. */
  ratio?: number;
  frames?: number;
  fps?: number;
}

/**
 * Verifies a temp file against the expectation, then renames it into place.
 * The temp file is always removed; a failed check never leaves a partial output behind.
 */
export async function commitOutput(temporary: string, absolute: string, relative: string, expected: OutputExpectation): Promise<RetrievedFile> {
  try {
    let output: RetrievedFile;
    const bytes = await readFile(temporary);
    if (expected.media === "image") {
      const info = await probeImage(temporary).catch(() => {
        throw new ExecutorFailure(jobError("provider", "The image output could not be decoded.", true));
      });
      assertSize(info.width, info.height, expected);
      output = { relativePath: relative, mime: info.mime, width: info.width, height: info.height, sha256: sha256(bytes) };
    } else {
      const info = await probeVideo(temporary).catch(() => {
        throw new ExecutorFailure(jobError("provider", "The video output could not be decoded. Check that ffmpeg and ffprobe are installed.", true));
      });
      assertSize(info.width, info.height, expected);
      if (info.codec !== "h264") throw new ExecutorFailure(jobError("provider", `The video output uses ${info.codec}, not H.264.`, false));
      if (expected.frames !== undefined && Math.abs(info.frames - expected.frames) > 1) {
        throw new ExecutorFailure(jobError("provider", `The video has ${info.frames} frames; ${expected.frames} were requested.`, false));
      }
      if (expected.fps !== undefined && Math.abs(info.fps - expected.fps) > 0.05) {
        throw new ExecutorFailure(jobError("provider", `The video plays at ${info.fps.toFixed(2)} fps; ${expected.fps} was requested.`, false));
      }
      output = {
        relativePath: relative,
        mime: "video/mp4",
        width: info.width,
        height: info.height,
        sha256: sha256(bytes),
        video: { frames: info.frames, fps: info.fps, durationSeconds: info.durationSeconds, hasAudio: info.hasAudio },
      };
    }
    await rename(temporary, absolute);
    return output;
  } finally {
    await rm(temporary, { force: true });
  }
}

function assertSize(width: number, height: number, expected: OutputExpectation): void {
  if (expected.width !== undefined && expected.height !== undefined && (width !== expected.width || height !== expected.height)) {
    throw new ExecutorFailure(jobError("provider", `The output is ${width}x${height}; ${expected.width}x${expected.height} was requested.`, false));
  }
  if (expected.ratio !== undefined && Math.abs(width / height - expected.ratio) > expected.ratio * 0.03) {
    throw new ExecutorFailure(jobError("provider", `The output is ${width}x${height}, which does not match the requested aspect ratio.`, false));
  }
}

/** File extension for a verified output mime type. */
export function extensionFor(mime: string): string {
  if (mime === "video/mp4") return "mp4";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/svg+xml") return "svg";
  return "png";
}
