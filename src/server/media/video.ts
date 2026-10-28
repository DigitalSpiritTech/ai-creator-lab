/**
 * Probes and verifies MP4 clips with ffprobe and extracts a poster frame with ffmpeg.
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { fail } from "@/lib/domain/failure";
import { childEnv } from "@/server/process";

const execute = promisify(execFile);

export const ProbeSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      pix_fmt: z.string().optional(),
      avg_frame_rate: z.string().optional(),
      nb_read_frames: z.string().optional(),
      duration: z.string().optional(),
    }),
  ),
  format: z.object({ duration: z.string() }),
});
export type Probe = z.infer<typeof ProbeSchema>;

export interface VideoExpectations {
  width?: number;
  height?: number;
  frameRate?: number;
  frameCount?: number;
  durationSeconds?: number;
  requireAudio?: boolean;
}

export interface ProbedVideo {
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  frameCount: number;
  hasAudio: boolean;
}

function executable(tool: "ffmpeg" | "ffprobe"): string {
  return process.env[tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] || tool;
}

/** Confirms ffmpeg and ffprobe respond before spending on a video. */
export async function checkVideoTools(): Promise<void> {
  try {
    await execute(executable("ffmpeg"), ["-version"], { env: childEnv(), timeout: 5000, maxBuffer: 64_000 });
    await execute(executable("ffprobe"), ["-version"], { env: childEnv(), timeout: 5000, maxBuffer: 64_000 });
  } catch {
    fail(
      "invalid",
      "Video needs FFmpeg and ffprobe on this computer. Install FFmpeg or set FFMPEG_PATH and FFPROBE_PATH, then recheck.",
    );
  }
}

/**
 * Reads playback metadata from an ffprobe report and checks it against expectations.
 * Requires H.264 in yuv420p; audio, when present or required, must be AAC.
 */
export function checkProbe(probe: Probe, expect: VideoExpectations = {}): ProbedVideo {
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const rate = video?.avg_frame_rate?.split("/").map(Number);
  const frameRate = rate?.length === 2 && rate[1] !== 0 ? rate[0] / rate[1] : NaN;
  const frameCount = Number(video?.nb_read_frames);
  const durationSeconds = Number(video?.duration ?? probe.format.duration);
  const problems: string[] = [];
  if (!video || video.codec_name !== "h264" || video.pix_fmt !== "yuv420p") problems.push("codec");
  if (!video?.width || !video.height) problems.push("size");
  if (expect.width !== undefined && video?.width !== expect.width) problems.push("width");
  if (expect.height !== undefined && video?.height !== expect.height) problems.push("height");
  if (!Number.isFinite(frameRate) || (expect.frameRate !== undefined && Math.abs(frameRate - expect.frameRate) > 0.01)) {
    problems.push("frame rate");
  }
  if (!Number.isInteger(frameCount) || frameCount <= 0 || (expect.frameCount !== undefined && frameCount !== expect.frameCount)) {
    problems.push("frame count");
  }
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    (expect.durationSeconds !== undefined && Math.abs(durationSeconds - expect.durationSeconds) > 0.1)
  ) {
    problems.push("duration");
  }
  if ((expect.requireAudio && !audio) || (audio && audio.codec_name !== "aac")) problems.push("audio");
  if (problems.length > 0) fail("provider", `The video does not match its recipe (${problems.join(", ")}).`);
  return {
    width: video!.width!,
    height: video!.height!,
    durationSeconds,
    frameRate,
    frameCount,
    hasAudio: audio !== undefined,
  };
}

export async function probeVideo(path: string): Promise<Probe> {
  const { stdout } = await execute(
    executable("ffprobe"),
    ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path],
    { env: childEnv(), timeout: 20_000, maxBuffer: 256_000 },
  );
  return ProbeSchema.parse(JSON.parse(stdout));
}

/** Probes, fully decodes, and checks a clip, then writes its first frame as a PNG poster. */
export async function verifyVideo(path: string, posterPath: string, expect: VideoExpectations = {}): Promise<ProbedVideo> {
  const metadata = checkProbe(await probeVideo(path), expect);
  const audioMap = metadata.hasAudio ? ["-map", "0:a:0"] : [];
  await execute(
    executable("ffmpeg"),
    ["-nostdin", "-v", "error", "-xerror", "-i", path, "-map", "0:v:0", ...audioMap, "-f", "null", "-"],
    { env: childEnv(), timeout: 45_000, maxBuffer: 256_000 },
  );
  await execute(
    executable("ffmpeg"),
    ["-nostdin", "-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-update", "1", "-f", "image2", "-c:v", "png", posterPath],
    { env: childEnv(), timeout: 15_000, maxBuffer: 256_000 },
  );
  return metadata;
}

/** Writes the first frame of a clip as a PNG poster. */
export async function extractPoster(path: string, posterPath: string): Promise<void> {
  await execute(
    executable("ffmpeg"),
    ["-nostdin", "-v", "error", "-y", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-update", "1", "-f", "image2", "-c:v", "png", posterPath],
    { env: childEnv(), timeout: 15_000, maxBuffer: 256_000 },
  );
}
