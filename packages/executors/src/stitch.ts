/**
 * The local half of a chained recording: the handover frame each next segment starts from, the slice
 * of the voice recording an audio-driven segment follows, the stitch (a short video crossfade at every
 * seam, the segments' own audio crossfaded, or the continuous voice recording as the audio spine), and the seam
 * check against the motion-review slop rules (black frames, a freeze, a visible jump, an audio gap
 * or click at a seam), all with ffmpeg filters.
 *
 * ffmpeg and ffprobe come from `ffmpegPath()` and `ffprobePath()` and run with `childEnv()`, so they
 * never see the app's keys.
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { ffmpegPath, probeVideo, tempBeside, type VideoInfo } from "./media";
import { childEnv } from "./process";

const execute = promisify(execFile);

async function ffmpeg(args: string[], timeout = 300_000): Promise<{ stdout: string; stderr: string }> {
  return execute(ffmpegPath(), ["-nostdin", "-hide_banner", "-nostats", ...args], { env: childEnv(), timeout, maxBuffer: 32_000_000 });
}

/**
 * Writes the frame `overlapSeconds` before a segment's end as a PNG: the next segment starts from it,
 * so its first `overlapSeconds` run alongside this segment's tail and the crossfade joins two
 * renderings of the same moment. With no overlap it is the last frame.
 */
export async function extractHandoverFrame(video: string, info: Pick<VideoInfo, "frames" | "fps">, overlapSeconds: number, out: string): Promise<void> {
  const index = Math.max(0, info.frames - 1 - Math.round(overlapSeconds * info.fps));
  const temporary = (await tempBeside(out)).replace(/\.tmp$/, ".png");
  try {
    await ffmpeg(["-v", "error", "-y", "-i", video, "-map", "0:v:0", "-vf", `select=eq(n\\,${index})`, "-fps_mode", "passthrough", "-frames:v", "1", "-update", "1", "-f", "image2", "-c:v", "png", temporary], 60_000);
    await rename(temporary, out);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Cuts `durationSeconds` of a recording from `startSeconds` as 48 kHz mono WAV, padded with silence past its end. */
export async function sliceAudio(source: string, startSeconds: number, durationSeconds: number, out: string): Promise<void> {
  const temporary = (await tempBeside(out)).replace(/\.tmp$/, ".wav");
  try {
    await ffmpeg(
      ["-v", "error", "-y", "-ss", startSeconds.toFixed(3), "-i", source, "-af", `apad=whole_dur=${durationSeconds.toFixed(3)}`, "-t", durationSeconds.toFixed(3), "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", temporary],
      60_000,
    );
    await rename(temporary, out);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface StitchSegment {
  path: string;
  /** The segment's measured video length. */
  durationSeconds: number;
  hasAudio: boolean;
}

export interface StitchRequest {
  segments: StitchSegment[];
  overlapSeconds: number;
  /** The continuous voice recording; when set it is the whole clip's audio and the segments' own is dropped. */
  spine?: { path: string };
  width: number;
  height: number;
  fps: number;
  /** Final location; written through a temp file beside it. */
  out: string;
}

export interface StitchResult {
  info: VideoInfo;
  /** The middle of each crossfade in the stitched clip, in seconds. */
  seams: number[];
  /** What ffmpeg was asked to do, for the record (no paths). */
  summary: string;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The xfade offsets (where each crossfade starts in the output) and the seam midpoints. */
export function crossfadeOffsets(durations: readonly number[], overlapSeconds: number): { offsets: number[]; seams: number[]; totalSeconds: number } {
  const offsets: number[] = [];
  let elapsed = 0;
  for (let index = 0; index < durations.length - 1; index++) {
    elapsed += durations[index] - overlapSeconds;
    offsets.push(round3(elapsed));
  }
  const totalSeconds = round3(durations.reduce((sum, value) => sum + value, 0) - (durations.length - 1) * overlapSeconds);
  return { offsets, seams: offsets.map((offset) => round3(offset + overlapSeconds / 2)), totalSeconds };
}

/** The filter graph for a stitch; exported for tests. */
export function stitchFilter(request: Omit<StitchRequest, "out">): { graph: string; totalSeconds: number; seams: number[] } {
  const { segments, overlapSeconds: o, width, height, fps } = request;
  if (segments.length < 2) throw new Error("A stitch joins at least two segments.");
  const { offsets, seams, totalSeconds } = crossfadeOffsets(
    segments.map((segment) => segment.durationSeconds),
    o,
  );
  const parts: string[] = [];
  segments.forEach((segment, index) => {
    parts.push(
      // The time base and start go first, then the frame rate: with fps before settb, FFmpeg 6.0 (the
      // bundled build) ends xfade's output when its first input ends.
      `[${index}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`,
    );
  });
  let video = "v0";
  offsets.forEach((offset, index) => {
    const next = index === offsets.length - 1 ? "vout" : `x${index + 1}`;
    parts.push(`[${video}][v${index + 1}]xfade=transition=fade:duration=${o.toFixed(3)}:offset=${offset.toFixed(3)}[${next}]`);
    video = next;
  });
  const audioFormat = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  if (request.spine) {
    parts.push(`[${segments.length}:a]${audioFormat},apad,atrim=0:${totalSeconds.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);
  } else {
    segments.forEach((segment, index) => {
      const length = segment.durationSeconds.toFixed(3);
      parts.push(
        segment.hasAudio
          ? `[${index}:a]${audioFormat},apad,atrim=0:${length},asetpts=PTS-STARTPTS[a${index}]`
          : `anullsrc=r=48000:cl=stereo,atrim=0:${length},aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`,
      );
    });
    let audio = "a0";
    for (let index = 1; index < segments.length; index++) {
      const next = index === segments.length - 1 ? "aout" : `y${index}`;
      parts.push(`[${audio}][a${index}]acrossfade=d=${o.toFixed(3)}:c1=tri:c2=tri[${next}]`);
      audio = next;
    }
  }
  return { graph: parts.join(";"), totalSeconds, seams };
}

/**
 * Joins the segments into one H.264 / AAC MP4 at the first segment's size and frame rate: a fade of
 * `overlapSeconds` at every seam, the segments' audio crossfaded over the same span, or the spine
 * as the one audio track. Verifies the result with ffprobe before moving it into place.
 */
export async function stitchTake(request: StitchRequest): Promise<StitchResult> {
  const { graph, totalSeconds, seams } = stitchFilter(request);
  const inputs = request.segments.flatMap((segment) => ["-i", segment.path]);
  if (request.spine) inputs.push("-i", request.spine.path);
  const temporary = (await tempBeside(request.out)).replace(/\.tmp$/, ".mp4");
  try {
    await ffmpeg([
      "-v", "error", "-y", ...inputs,
      "-filter_complex", graph,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(request.fps),
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-t", totalSeconds.toFixed(3), "-movflags", "+faststart", temporary,
    ]);
    const info = await probeVideo(temporary);
    if (!info.hasAudio) throw new Error("The stitched clip has no audio track.");
    await rename(temporary, request.out);
    const audio = request.spine ? "the voice recording as the one audio track" : `the segments' audio crossfaded over ${request.overlapSeconds.toFixed(3)} s`;
    return { info, seams, summary: `${request.segments.length} segments, ${request.overlapSeconds.toFixed(3)} s video crossfades at ${request.width}x${request.height} ${request.fps} fps, ${audio}; H.264 CRF 18, AAC 160k.` };
  } finally {
    await rm(temporary, { force: true });
  }
}

export type SeamIssue = "black" | "freeze" | "jump" | "audio_gap" | "audio_click";

export interface SeamReport {
  seconds: number;
  issues: SeamIssue[];
  /** Largest frame-to-frame luma difference (signalstats YDIF) near the seam, and the clip's median. */
  videoDifference: number;
  videoBaseline: number;
  /** Quietest 25 ms window near the seam in dBFS (null when the clip has no audio). */
  quietestDb: number | null;
  /** Largest sample-to-sample step near the seam over the clip's median step. */
  clickRatio: number | null;
}

/** How far around a seam the video checks look, and the audio checks (half of it). */
export const SEAM_WINDOW_SECONDS = 0.5;
const GAP_DB = -50;

interface Interval {
  start: number;
  end: number;
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Per-frame metadata lines from `metadata=print`, grouped by the frame's time. */
function frameValues(log: string, key: string): { time: number; value: number }[] {
  const values: { time: number; value: number }[] = [];
  let time = Number.NaN;
  for (const line of log.split("\n")) {
    const frame = /pts_time:(-?[\d.]+)/.exec(line);
    if (frame) {
      time = Number(frame[1]);
      continue;
    }
    const match = new RegExp(`${key.replaceAll(".", "\\.")}=(-?[\\d.]+|-?inf)`).exec(line);
    if (match && Number.isFinite(time)) values.push({ time, value: match[1].endsWith("inf") ? -Infinity : Number(match[1]) });
  }
  return values;
}

function intervals(log: string, startKey: RegExp, endKey: RegExp, totalSeconds: number): Interval[] {
  const found: Interval[] = [];
  let open: number | undefined;
  for (const line of log.split("\n")) {
    const start = startKey.exec(line);
    if (start) open = Number(start[1]);
    const end = endKey.exec(line);
    if (end && open !== undefined) {
      found.push({ start: open, end: Number(end[1]) });
      open = undefined;
    }
  }
  if (open !== undefined) found.push({ start: open, end: totalSeconds });
  return found;
}

const overlaps = (interval: Interval, from: number, to: number) => interval.start < to && interval.end > from;

/**
 * Checks every seam of a stitched clip with ffmpeg filters: `blackdetect` (black frames), `freezedetect`
 * (a held picture), `signalstats` YDIF (a frame-to-frame jump well above the clip's median), and on
 * the audio `silencedetect` plus 25 ms `astats` windows (a gap below -50 dBFS) and the same windows
 * over `aderivative` (a click: a sample-to-sample step more than six times the clip's median).
 */
export async function checkSeams(path: string, seams: readonly number[], totalSeconds: number): Promise<SeamReport[]> {
  const video = await ffmpeg(
    ["-v", "info", "-i", path, "-an", "-vf", "signalstats,blackdetect=d=0.04:pix_th=0.10,freezedetect=n=-60dB:d=0.4,metadata=mode=print", "-f", "null", "-"],
    300_000,
  );
  const ydif = frameValues(video.stderr, "lavfi.signalstats.YDIF").filter((entry) => entry.time > 0);
  const black = intervals(video.stderr, /black_start:\s*([\d.]+)/, /black_end:\s*([\d.]+)/, totalSeconds);
  const frozen = intervals(video.stderr, /lavfi\.freezedetect\.freeze_start[:=]\s*([\d.]+)/, /lavfi\.freezedetect\.freeze_end[:=]\s*([\d.]+)/, totalSeconds);
  const baseline = median(ydif.map((entry) => entry.value));

  let rms: { time: number; value: number }[] = [];
  let steps: { time: number; value: number }[] = [];
  let silent: Interval[] = [];
  let hasAudio = true;
  try {
    const windows = "asetnsamples=n=1200:p=0,astats=metadata=1:reset=1";
    const audio = await ffmpeg(
      ["-v", "info", "-i", path, "-vn", "-af", `silencedetect=n=${GAP_DB}dB:d=0.1,${windows},ametadata=mode=print:key=lavfi.astats.Overall.RMS_level`, "-f", "null", "-"],
      300_000,
    );
    rms = frameValues(audio.stderr, "lavfi.astats.Overall.RMS_level");
    silent = intervals(audio.stderr, /silence_start:\s*(-?[\d.]+)/, /silence_end:\s*([\d.]+)/, totalSeconds);
    // The sample-to-sample step is the derivative's peak; aderivative runs on the whole stream, so a
    // jump on a window boundary is still seen.
    const derivative = await ffmpeg(
      ["-v", "info", "-i", path, "-vn", "-af", `aderivative,${windows},ametadata=mode=print:key=lavfi.astats.Overall.Peak_level`, "-f", "null", "-"],
      300_000,
    );
    steps = frameValues(derivative.stderr, "lavfi.astats.Overall.Peak_level").map((entry) => ({ time: entry.time, value: Number.isFinite(entry.value) ? 10 ** (entry.value / 20) : 0 }));
    hasAudio = rms.length > 0;
  } catch {
    hasAudio = false;
  }
  const stepBaseline = median(steps.map((entry) => entry.value));

  return seams.map((seconds) => {
    const from = seconds - SEAM_WINDOW_SECONDS;
    const to = seconds + SEAM_WINDOW_SECONDS;
    const near = ydif.filter((entry) => entry.time >= from && entry.time <= to);
    const videoDifference = near.length ? Math.max(...near.map((entry) => entry.value)) : 0;
    const issues: SeamIssue[] = [];
    if (black.some((interval) => overlaps(interval, from, to))) issues.push("black");
    if (frozen.some((interval) => overlaps(interval, from, to))) issues.push("freeze");
    if (videoDifference > Math.max(baseline * 4, baseline + 6)) issues.push("jump");
    let quietestDb: number | null = null;
    let clickRatio: number | null = null;
    if (hasAudio) {
      const half = SEAM_WINDOW_SECONDS / 2;
      const windows = rms.filter((entry) => entry.time >= seconds - half && entry.time <= seconds + half);
      quietestDb = windows.length ? Math.min(...windows.map((entry) => entry.value)) : null;
      if (silent.some((interval) => overlaps(interval, seconds - half, seconds + half)) || (quietestDb !== null && quietestDb < GAP_DB)) issues.push("audio_gap");
      const local = steps.filter((entry) => entry.time >= seconds - half && entry.time <= seconds + half);
      if (local.length && stepBaseline > 0) {
        clickRatio = Math.round((Math.max(...local.map((entry) => entry.value)) / stepBaseline) * 100) / 100;
        if (clickRatio > 6) issues.push("audio_click");
      }
    }
    return {
      seconds,
      issues,
      videoDifference: Math.round(videoDifference * 100) / 100,
      videoBaseline: Math.round(baseline * 100) / 100,
      // Digital silence reads as -inf; it is reported at the floor of what 16-bit audio can carry.
      quietestDb: quietestDb === null ? null : Math.round(Math.max(-120, quietestDb) * 10) / 10,
      clickRatio,
    };
  });
}

/** Plain words for a seam issue, for notices and the record. */
export const SEAM_ISSUE_TEXT: Record<SeamIssue, string> = {
  black: "black frames",
  freeze: "a frozen picture",
  jump: "a visible jump",
  audio_gap: "a gap in the audio",
  audio_click: "a click in the audio",
};
