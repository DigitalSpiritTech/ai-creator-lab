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

export const EMPTY_OUTPUT_CODE = "empty_output";
export const EMPTY_OUTPUT_MESSAGE = "The model returned a black or empty output";
export const EMPTY_OUTPUT_NOTICE =
  "The model returned a black or empty output; the credits for it were spent. One automatic retry with a new seed follows when the recipe takes a seed and the allowance permits.";

/** Mean luma below this (full range, 0 to 255) counts as black. */
const BLACK_LUMA = 4;
/** A frame whose luma spans no more than this is flat. */
const FLAT_RANGE = 4;

export interface LumaSample {
  avg: number;
  min: number;
  max: number;
}

/**
 * Luma statistics (full range) from ffmpeg `signalstats`: five frames spread across a video, or the
 * single frame of an image.
 */
export async function sampleLuma(path: string, frames?: number): Promise<LumaSample[]> {
  const step = frames && frames > 1 ? Math.max(1, Math.ceil(frames / 5)) : 1;
  const filters = [...(frames && frames > 1 ? [`select=not(mod(n\\,${step}))`] : []), "scale=out_range=full", "format=yuvj444p", "signalstats", "metadata=print"];
  const { stderr } = await execute(ffmpegPath(), ["-nostdin", "-hide_banner", "-nostats", "-v", "info", "-i", path, "-vf", filters.join(","), "-an", "-f", "null", "-"], {
    timeout: 120_000,
    maxBuffer: 8_000_000,
  });
  const samples: LumaSample[] = [];
  let current: Partial<LumaSample> = {};
  for (const match of stderr.matchAll(/lavfi\.signalstats\.(YMIN|YAVG|YMAX)=([\d.]+)/g)) {
    const key = match[1] === "YMIN" ? "min" : match[1] === "YAVG" ? "avg" : "max";
    current[key] = Number(match[2]);
    if (current.min !== undefined && current.avg !== undefined && current.max !== undefined) {
      samples.push(current as LumaSample);
      current = {};
    }
  }
  if (!samples.length) throw new Error("No luma statistics.");
  return samples.slice(0, 5);
}

/** Black (mean luma under 4) or blank (every sample flat and identical). */
export function looksEmpty(samples: LumaSample[]): boolean {
  const mean = samples.reduce((sum, sample) => sum + sample.avg, 0) / samples.length;
  if (mean < BLACK_LUMA) return true;
  const flat = samples.every((sample) => sample.max - sample.min <= FLAT_RANGE);
  const averages = samples.map((sample) => sample.avg);
  return flat && Math.max(...averages) - Math.min(...averages) <= 1;
}

/** Fails a black or blank output as a provider failure; the run may retry it once with a new seed. */
export async function assertNotEmpty(path: string, frames?: number): Promise<void> {
  const samples = await sampleLuma(path, frames).catch(() => {
    throw new ExecutorFailure(jobError("provider", "The output's pixels could not be read. Check that ffmpeg is installed.", true));
  });
  if (looksEmpty(samples)) throw new ExecutorFailure(jobError("provider", EMPTY_OUTPUT_MESSAGE, true, EMPTY_OUTPUT_CODE));
}

/** Whether a failure is the black-or-empty verdict, which is final for the job even though it is retryable. */
export function isEmptyOutput(error: { providerCode?: string }): boolean {
  return error.providerCode === EMPTY_OUTPUT_CODE;
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
      await assertNotEmpty(temporary);
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
      await assertNotEmpty(temporary, info.frames);
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
