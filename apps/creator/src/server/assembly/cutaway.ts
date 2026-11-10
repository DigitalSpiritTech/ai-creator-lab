/**
 * The take-then-cutaways ffmpeg plan: one continuous talking take on the 1080 x 1920, 24 fps
 * canvas, its picture replaced in each EDL window by the beat's approved clip (from the clip's
 * first frame, held on its last when the window is longer), captions burned in at the EDL's times,
 * and the take's own sound mapped straight through. When the take's audio is AAC it is stream
 * copied, so the export's sound is the take's, packet for packet; anything else is encoded to AAC
 * once. Pure: no files, no processes.
 * @packageDocumentation
 */
import { EXPORT_FPS, EXPORT_HEIGHT, EXPORT_WIDTH } from "@creator-lab/core/domain/content";
import { captionFilters } from "@/server/assembly/captions";
import { AUDIO_BITRATE, AUDIO_RATE, EXPORT_CRF, type Segment, canvasFilters } from "@/server/assembly/graph";

/** How the take's sound reaches the export: copied as it is, encoded to AAC, or dropped (muted). */
export type TakeAudio = "copy" | "encode" | "none";

export interface CutawayTake {
  path: string;
  /** The take's length on the canvas, in whole frames at 24 fps. */
  frames: number;
  width?: number;
  height?: number;
  audio: TakeAudio;
}

/** One window: the clip (or still) shown from `startFrame` up to, not including, `endFrame` of the take. */
export interface CutawayWindow extends Pick<Segment, "source" | "path" | "width" | "height"> {
  beatIndex: number;
  startFrame: number;
  endFrame: number;
}

export interface CutawayCaption {
  start: number;
  end: number;
  text: string;
}

export interface CutawayPlan {
  args: string[];
  filterGraph: string;
  totalFrames: number;
  durationSeconds: number;
  /** The timeline as the export plays it: take and window parts in order, in frames. */
  parts: { kind: "take" | "window"; beatIndex?: number; startFrame: number; endFrame: number }[];
  summary: string;
}

/** Seconds on the 24 fps timeline to the nearest frame boundary. */
export function frameAt(seconds: number): number {
  return Math.round(seconds * EXPORT_FPS);
}

function inputArgs(window: CutawayWindow): string[] {
  const seconds = ((window.endFrame - window.startFrame) / EXPORT_FPS).toFixed(6);
  return window.source === "still" ? ["-loop", "1", "-framerate", String(EXPORT_FPS), "-t", seconds, "-i", window.path] : ["-noautorotate", "-i", window.path];
}

/**
 * Plans the cutaway render. Windows are clamped to the take, sorted, and must not overlap (the EDL
 * guarantees it); a window shorter than one frame is dropped. The take is input 0, the windows
 * follow in time order.
 */
export function planCutaways(
  take: CutawayTake,
  windows: CutawayWindow[],
  captions: CutawayCaption[],
  options: { fontPath?: string; output: string },
): CutawayPlan {
  if (take.frames <= 0) throw new Error("The recording has no frames.");
  const total = take.frames;
  const placed = windows
    .map((window) => ({ ...window, startFrame: Math.max(0, Math.min(total, window.startFrame)), endFrame: Math.max(0, Math.min(total, window.endFrame)) }))
    .filter((window) => window.endFrame > window.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame);
  const parts: CutawayPlan["parts"] = [];
  let cursor = 0;
  for (const window of placed) {
    if (window.startFrame < cursor) throw new Error(`The window for beat ${window.beatIndex} overlaps the one before it.`);
    if (window.startFrame > cursor) parts.push({ kind: "take", startFrame: cursor, endFrame: window.startFrame });
    parts.push({ kind: "window", beatIndex: window.beatIndex, startFrame: window.startFrame, endFrame: window.endFrame });
    cursor = window.endFrame;
  }
  if (cursor < total) parts.push({ kind: "take", startFrame: cursor, endFrame: total });

  const chains: string[] = [];
  const takeParts = parts.filter((part) => part.kind === "take");
  const takeBase = `[0:v:0]${canvasFilters({ width: take.width, height: take.height, frames: total }).join(",")}`;
  if (takeParts.length > 0) {
    const labels = takeParts.map((_, index) => `[t${index}]`);
    chains.push(takeParts.length === 1 ? `${takeBase}${labels[0]}` : `${takeBase},split=${takeParts.length}${labels.join("")}`);
  }
  let takeIndex = 0;
  let windowInput = 1;
  const joined: string[] = [];
  parts.forEach((part, index) => {
    const label = `[p${index}]`;
    if (part.kind === "take") {
      chains.push(`[t${takeIndex++}]trim=start_frame=${part.startFrame}:end_frame=${part.endFrame},setpts=PTS-STARTPTS${label}`);
    } else {
      const window = placed.find((entry) => entry.startFrame === part.startFrame)!;
      chains.push(`[${windowInput++}:v:0]${canvasFilters({ width: window.width, height: window.height, frames: part.endFrame - part.startFrame }).join(",")}${label}`);
    }
    joined.push(label);
  });
  const timed = options.fontPath
    ? captions.map((cue) => captionFilters(cue.text, options.fontPath!, { start: cue.start, end: cue.end })).filter(Boolean)
    : [];
  const join = joined.length === 1 ? `${joined[0]}null[joined]` : `${joined.join("")}concat=n=${joined.length}:v=1:a=0[joined]`;
  chains.push(join);
  chains.push(`[joined]${[...timed, "format=yuv420p"].join(",")}[video]`);
  const filterGraph = chains.join(";");

  const audioArgs =
    take.audio === "none"
      ? ["-an"]
      : take.audio === "copy"
        ? ["-map", "0:a:0", "-c:a", "copy"]
        : ["-map", "0:a:0", "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", String(AUDIO_RATE), "-ac", "2"];
  const args = [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-noautorotate",
    "-i",
    take.path,
    ...placed.flatMap(inputArgs),
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
    options.output,
  ];
  const seconds = (frames: number) => (frames / EXPORT_FPS).toFixed(2);
  const summary = [
    `recording ${total}f with ${placed.length} cutaway window${placed.length === 1 ? "" : "s"}${placed.length ? ` (${placed.map((window) => `beat ${window.beatIndex} ${seconds(window.startFrame)}-${seconds(window.endFrame)} s`).join(", ")})` : ""}`,
    `video: scale to fit, ${EXPORT_WIDTH}x${EXPORT_HEIGHT}, setsar=1, fps=${EXPORT_FPS}, recording trimmed around the windows, concat n=${joined.length}${timed.length ? `, ${captions.length} timed drawtext caption${captions.length === 1 ? "" : "s"}` : ""}`,
    take.audio === "none" ? "audio: none (muted)" : take.audio === "copy" ? "audio: the recording's AAC track, stream copied (untouched)" : `audio: the recording's track encoded once to AAC ${AUDIO_BITRATE}`,
    `encode: libx264 crf ${EXPORT_CRF} yuv420p +faststart`,
  ].join("; ");
  return { args, filterGraph, totalFrames: total, durationSeconds: total / EXPORT_FPS, parts, summary };
}
