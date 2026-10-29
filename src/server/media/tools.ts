/**
 * The video tools report for Settings: which ffmpeg and ffprobe the app runs, their versions,
 * and whether captions can be burned in (the `drawtext` filter). Paths only, never arguments
 * from user data; every failure becomes a readable message.
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { supportsDrawtext } from "@/server/assembly/render";
import { ffmpegPath, ffprobePath } from "@/server/executors/media";
import { captionFontPath } from "@/server/assembly/captions";
import { childEnv } from "@/server/process";

const execute = promisify(execFile);

export interface VideoToolsReport {
  ffmpeg: { path: string; version: string | null };
  ffprobe: { path: string; version: string | null };
  /** Whether captions can be burned in: drawtext present and the font file found. */
  captions: boolean;
  /** Where the paths came from, for the hint under the report. */
  source: "environment" | "homebrew-full" | "path";
  message: string;
  checkedAt: number;
}

async function version(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execute(binary, ["-version"], { env: childEnv(), timeout: 5000, maxBuffer: 64_000 });
    const match = /^(?:ffmpeg|ffprobe) version (\S+)/.exec(stdout);
    return match ? match[1] : stdout.split("\n")[0]?.trim() || "unknown";
  } catch {
    return null;
  }
}

/** Runs the two binaries and the drawtext check; never throws. */
export async function checkVideoToolsReport(now = Date.now()): Promise<VideoToolsReport> {
  const ffmpeg = ffmpegPath();
  const ffprobe = ffprobePath();
  const [ffmpegVersion, ffprobeVersion] = await Promise.all([version(ffmpeg), version(ffprobe)]);
  const drawtext = ffmpegVersion ? await supportsDrawtext() : false;
  const font = !!captionFontPath();
  const source = process.env.FFMPEG_PATH?.trim() ? "environment" : ffmpeg.includes("/opt/ffmpeg-full/") ? "homebrew-full" : "path";
  let message: string;
  if (!ffmpegVersion || !ffprobeVersion) {
    message = `${!ffmpegVersion ? "ffmpeg" : "ffprobe"} did not respond at ${!ffmpegVersion ? ffmpeg : ffprobe}. Install FFmpeg, or set FFMPEG_PATH and FFPROBE_PATH in .env.local and restart.`;
  } else if (!drawtext) {
    message = `FFmpeg ${ffmpegVersion} runs, but this build has no drawtext filter, so captions cannot be burned in. On macOS run "brew install ffmpeg-full"; elsewhere install a build with libfreetype. Exports without captions still work.`;
  } else if (!font) {
    message = `FFmpeg ${ffmpegVersion} runs with drawtext, but the caption font is missing. Restore assets/fonts/DejaVuSans-Bold.ttf or set CAPTION_FONT_PATH.`;
  } else {
    message = `FFmpeg ${ffmpegVersion} and ffprobe ${ffprobeVersion} are ready; captions are available.`;
  }
  return {
    ffmpeg: { path: ffmpeg, version: ffmpegVersion },
    ffprobe: { path: ffprobe, version: ffprobeVersion },
    captions: drawtext && font,
    source,
    message,
    checkedAt: now,
  };
}
