/**
 * Builds the ffmpeg filter graph and encoder arguments that join normalized segments into one
 * 1080 x 1920, 24 fps H.264 MP4. Pure: no files, no processes.
 * @packageDocumentation
 */
import { EXPORT_FPS, EXPORT_HEIGHT, EXPORT_WIDTH } from "@/lib/domain/content";
import { captionFilters } from "@/server/assembly/captions";

export const EXPORT_CRF = 19;
export const AUDIO_RATE = 48_000;
export const AUDIO_BITRATE = "160k";

/** One input file prepared for the join. */
export interface Segment {
  /** A video clip, or a still image looped for the segment's length. */
  source: "video" | "still";
  path: string;
  hasAudio: boolean;
  frames: number;
  /** Caption text burned in for this segment; empty draws nothing. */
  caption: string;
}

export interface AssemblyPlan {
  /** Arguments for one ffmpeg invocation, output path last. */
  args: string[];
  filterGraph: string;
  totalFrames: number;
  durationSeconds: number;
  summary: string;
}

function seconds(frames: number): string {
  return (frames / EXPORT_FPS).toFixed(6);
}

function inputArgs(segment: Segment): string[] {
  if (segment.source === "still") {
    return ["-loop", "1", "-framerate", String(EXPORT_FPS), "-t", seconds(segment.frames), "-i", segment.path];
  }
  return ["-noautorotate", "-i", segment.path];
}

function videoChain(index: number, segment: Segment, fontPath: string | undefined): string {
  const filters = [
    "setpts=PTS-STARTPTS",
    `scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`,
    `pad=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    `fps=${EXPORT_FPS}`,
    "tpad=stop_mode=clone:stop_duration=1",
    `trim=end_frame=${segment.frames}`,
    "setpts=PTS-STARTPTS",
  ];
  const caption = fontPath ? captionFilters(segment.caption, fontPath) : "";
  if (caption) filters.push(caption);
  filters.push("format=yuv420p");
  return `[${index}:v:0]${filters.join(",")}[v${index}]`;
}

function audioChain(index: number, segment: Segment): string {
  const length = `atrim=duration=${seconds(segment.frames)},asetpts=PTS-STARTPTS`;
  if (!segment.hasAudio) return `anullsrc=r=${AUDIO_RATE}:cl=stereo,${length}[a${index}]`;
  return [
    `[${index}:a:0]asetpts=PTS-STARTPTS`,
    `aresample=${AUDIO_RATE}`,
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
    "apad",
    `${length}[a${index}]`,
  ].join(",");
}

/**
 * Plans the join: each segment is scaled to fit, padded to exactly 1080 x 1920, set to square
 * pixels and 24 fps, held or trimmed to its frame count, and optionally captioned. Audio is
 * resampled to 48 kHz stereo with silence where a clip has none, or dropped when muted. The
 * concat filter (not the demuxer) joins them so mixed sources line up.
 */
export function planAssembly(
  segments: Segment[],
  options: { mute: boolean; fontPath?: string; output: string },
): AssemblyPlan {
  if (segments.length === 0) throw new Error("Nothing to assemble.");
  const chains: string[] = [];
  const labels: string[] = [];
  segments.forEach((segment, index) => {
    chains.push(videoChain(index, segment, options.fontPath));
    labels.push(`[v${index}]`);
    if (!options.mute) {
      chains.push(audioChain(index, segment));
      labels.push(`[a${index}]`);
    }
  });
  const audio = options.mute ? 0 : 1;
  chains.push(`${labels.join("")}concat=n=${segments.length}:v=1:a=${audio}[video]${audio ? "[audio]" : ""}`);
  const filterGraph = chains.join(";");
  const totalFrames = segments.reduce((sum, segment) => sum + segment.frames, 0);
  const audioArgs = options.mute
    ? ["-an"]
    : ["-map", "[audio]", "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", String(AUDIO_RATE), "-ac", "2"];
  const args = [
    "-nostdin",
    "-v",
    "error",
    "-y",
    ...segments.flatMap(inputArgs),
    "-filter_complex",
    filterGraph,
    "-map",
    "[video]",
    ...audioArgs,
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    String(EXPORT_CRF),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(EXPORT_FPS),
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    "-t",
    seconds(totalFrames),
    options.output,
  ];
  const captioned = !!options.fontPath && segments.some((segment) => segment.caption.trim().length > 0);
  const summary = [
    `${segments.length} segment${segments.length === 1 ? "" : "s"} (${segments.map((segment) => `${segment.source} ${segment.frames}f`).join(", ")})`,
    `video: scale to fit, pad ${EXPORT_WIDTH}x${EXPORT_HEIGHT}, setsar=1, fps=${EXPORT_FPS}${captioned ? ", drawtext captions" : ""}`,
    options.mute ? "audio: none (muted)" : `audio: aresample ${AUDIO_RATE} Hz stereo, anullsrc for silent clips`,
    `join: concat filter n=${segments.length}:v=1:a=${audio}`,
    `encode: libx264 crf ${EXPORT_CRF} yuv420p +faststart${options.mute ? "" : `, aac ${AUDIO_BITRATE}`}`,
  ].join("; ");
  return { args, filterGraph, totalFrames, durationSeconds: totalFrames / EXPORT_FPS, summary };
}
