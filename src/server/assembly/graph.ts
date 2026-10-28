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

/** A voice-over mixed over a segment: the clip's own sound is ducked under it. */
export interface VoiceOver {
  path: string;
  durationSeconds: number;
}

/** One input file prepared for the join. */
export interface Segment {
  /** A video clip, or a still image looped for the segment's length. */
  source: "video" | "still";
  path: string;
  hasAudio: boolean;
  frames: number;
  /** Caption text burned in for this segment; empty draws nothing. */
  caption: string;
  /** Source pixel size, when known; decides fill-and-crop against fit-and-pad. */
  width?: number;
  height?: number;
  /** The clip's own sound is speech (a talking beat): leveled like the voice-overs. */
  speech?: boolean;
  voice?: VoiceOver;
}

/** The clip's own sound under a voice-over, as a gain (about -9 dB). */
export const DUCK_GAIN = 0.35;
/** The voice-over starts this far into its segment. */
export const VOICE_LEAD_SECONDS = 0.15;
/** A take that runs past its segment is sped up by at most this much before it is trimmed. */
export const VOICE_MAX_TEMPO = 1.2;
/** Takes are leveled to this integrated loudness (LUFS) so every voice-over sits where the talking clips do. */
export const VOICE_LOUDNESS = -20;
const VOICE_FADE_SECONDS = 0.1;

/**
 * How a voice-over fits its segment: the tempo (1 when it fits as it is, up to VOICE_MAX_TEMPO)
 * and whether it is trimmed anyway. The lead and a short fade count against the segment.
 */
export function voiceFit(voice: VoiceOver, segmentSeconds: number): { tempo: number; trimmed: boolean } {
  const room = segmentSeconds - VOICE_LEAD_SECONDS - VOICE_FADE_SECONDS;
  if (room <= 0) return { tempo: VOICE_MAX_TEMPO, trimmed: true };
  const needed = voice.durationSeconds / room;
  if (needed <= 1) return { tempo: 1, trimmed: false };
  const tempo = Math.min(VOICE_MAX_TEMPO, Math.ceil(needed * 100) / 100);
  return { tempo, trimmed: needed > VOICE_MAX_TEMPO };
}

/** Aspect ratios this close to 9:16 are filled and center-cropped; anything further off is letterboxed. */
export const FILL_TOLERANCE = 0.03;

/**
 * Whether a source fills the canvas (losing a sliver at the edges) or fits inside it with black bars.
 * Every clip the app makes is composed at 9:16, so a provider's near miss (Kling returns 1088x1904)
 * fills; a genuinely different shape, or an unknown size, keeps all of its picture.
 */
export function fillsCanvas(segment: Pick<Segment, "width" | "height">): boolean {
  if (!segment.width || !segment.height) return false;
  return Math.abs((segment.width / segment.height) / (EXPORT_WIDTH / EXPORT_HEIGHT) - 1) <= FILL_TOLERANCE;
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
  const main =
    segment.source === "still"
      ? ["-loop", "1", "-framerate", String(EXPORT_FPS), "-t", seconds(segment.frames), "-i", segment.path]
      : ["-noautorotate", "-i", segment.path];
  return segment.voice ? [...main, "-i", segment.voice.path] : main;
}

function videoChain(index: number, input: number, segment: Segment, fontPath: string | undefined): string {
  const filters = [
    "setpts=PTS-STARTPTS",
    ...(fillsCanvas(segment)
      ? [`scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos`, `crop=${EXPORT_WIDTH}:${EXPORT_HEIGHT}`]
      : [
          `scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`,
          `pad=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
        ]),
    "setsar=1",
    `fps=${EXPORT_FPS}`,
    "tpad=stop_mode=clone:stop_duration=1",
    `trim=end_frame=${segment.frames}`,
    "setpts=PTS-STARTPTS",
  ];
  const caption = fontPath ? captionFilters(segment.caption, fontPath) : "";
  if (caption) filters.push(caption);
  filters.push("format=yuv420p");
  return `[${input}:v:0]${filters.join(",")}[v${index}]`;
}

/**
 * The segment's own sound, resampled and held to its length (silence when the clip has none),
 * then, under a voice-over, ducked and mixed with the take: the take starts after a short lead,
 * is sped up a little when it would run past the segment, and fades out at the segment's end.
 */
function audioChain(index: number, input: number, segment: Segment): string {
  const length = `atrim=duration=${seconds(segment.frames)},asetpts=PTS-STARTPTS`;
  const label = segment.voice ? `[bed${index}]` : `[a${index}]`;
  const bed = !segment.hasAudio
    ? `anullsrc=r=${AUDIO_RATE}:cl=stereo,${length}${segment.voice ? `,volume=${DUCK_GAIN}` : ""}${label}`
    : [
        `[${input}:a:0]asetpts=PTS-STARTPTS`,
        ...(segment.speech && !segment.voice ? [`loudnorm=I=${VOICE_LOUDNESS}:TP=-1.5:LRA=11`] : []),
        `aresample=${AUDIO_RATE}`,
        "aformat=sample_fmts=fltp:channel_layouts=stereo",
        "apad",
        length,
        ...(segment.voice ? [`volume=${DUCK_GAIN}`] : []),
      ].join(",") + label;
  if (!segment.voice) return bed;
  const segmentSeconds = segment.frames / EXPORT_FPS;
  const { tempo } = voiceFit(segment.voice, segmentSeconds);
  const fadeStart = Math.max(0, segmentSeconds - VOICE_FADE_SECONDS).toFixed(3);
  const take = [
    `[${input + 1}:a:0]asetpts=PTS-STARTPTS`,
    `loudnorm=I=${VOICE_LOUDNESS}:TP=-1.5:LRA=11`,
    `aresample=${AUDIO_RATE}`,
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
    ...(tempo > 1 ? [`atempo=${tempo.toFixed(2)}`] : []),
    `adelay=${Math.round(VOICE_LEAD_SECONDS * 1000)}:all=1`,
    "apad",
    length,
    `afade=t=out:st=${fadeStart}:d=${VOICE_FADE_SECONDS}[take${index}]`,
  ].join(",");
  return `${bed};${take};[bed${index}][take${index}]amix=inputs=2:duration=first:normalize=0[a${index}]`;
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
  let input = 0;
  segments.forEach((segment, index) => {
    chains.push(videoChain(index, input, segment, options.fontPath));
    labels.push(`[v${index}]`);
    if (!options.mute) {
      chains.push(audioChain(index, input, segment));
      labels.push(`[a${index}]`);
    }
    input += segment.voice ? 2 : 1;
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
  const voiced = options.mute ? 0 : segments.filter((segment) => segment.voice).length;
  const spoken = options.mute ? 0 : segments.filter((segment) => segment.speech && segment.hasAudio && !segment.voice).length;
  const summary = [
    `${segments.length} segment${segments.length === 1 ? "" : "s"} (${segments.map((segment) => `${segment.source} ${segment.frames}f${segment.voice ? " +voice" : ""}`).join(", ")})`,
    `video: scale to fit, pad ${EXPORT_WIDTH}x${EXPORT_HEIGHT}, setsar=1, fps=${EXPORT_FPS}${captioned ? ", drawtext captions" : ""}`,
    options.mute ? "audio: none (muted)" : `audio: aresample ${AUDIO_RATE} Hz stereo, anullsrc for silent clips${spoken ? `, ${spoken} talking clip${spoken === 1 ? "" : "s"} leveled to ${VOICE_LOUDNESS} LUFS` : ""}${voiced ? `, ${voiced} voice-over${voiced === 1 ? "" : "s"} leveled to ${VOICE_LOUDNESS} LUFS and mixed over the clip at ${DUCK_GAIN} gain` : ""}`,
    `join: concat filter n=${segments.length}:v=1:a=${audio}`,
    `encode: libx264 crf ${EXPORT_CRF} yuv420p +faststart${options.mute ? "" : `, aac ${AUDIO_BITRATE}`}`,
  ].join("; ");
  return { args, filterGraph, totalFrames, durationSeconds: totalFrames / EXPORT_FPS, summary };
}
