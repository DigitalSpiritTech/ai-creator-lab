/**
 * Credit-free executor: deterministic, visibly labeled SVG stills for image capabilities and static
 * storyboard plates for video capabilities, with an optional simulated failure. No network.
 *
 * With `video: "mp4"` (the app sets it from `MOCK_VIDEO=mp4`) video capabilities make real short
 * MP4 clips with ffmpeg instead: the first input image scrolling slowly sideways (so frame 0 is the
 * input exactly and a clip started from another clip's frame carries on its motion), or `testsrc2`
 * when there is none, with a steady 220 Hz tone, or the input voice recording for speech to video.
 * Chained recordings need these, since a storyboard has no frames to hand over or stitch.
 *
 * Two outputs are always real files, because the next step reads them: an Ad's take (target `take`, slot
 * `clip`) is an H.264 MP4 with a speech-like tone track, made by ffmpeg's lavfi sources, so it can
 * be transcribed and cut; a transcription (`speech_to_text`) is a transcript JSON whose words are
 * the prompt's (the script's lines) spread over the recording's length, or a test's fixture.
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { capabilityMedia, ratioValue, type AspectRatio } from "@creator-lab/core/catalog";
import { usdToCredits } from "@creator-lab/core/domain/spend";
import { type Transcript, parseTranscript } from "@creator-lab/core/domain/transcript";
import {
  ExecutorFailure,
  claimForSubmit,
  failJob,
  jobError,
  loadJob,
  patchJob,
  toJobError,
  transition,
} from "./jobs";
import { commitOutput, ffmpegPath, outputLocation, probeAudio, probeVideo, sha256, tempBeside } from "./media";
import { childEnv } from "./process";
import type {
  CancelOutcome,
  EstimateOutcome,
  Executor,
  GenerationInput,
  Job,
  JobStorePort,
  PollOutcome,
  RetrieveDestination,
  RetrieveOutcome,
  RetrievedFile,
  SubmitOutcome,
} from "./types";

export type MockStage = "submit" | "poll" | "retrieve";

/** What a mock video job writes: a static SVG storyboard plate, or a real MP4 clip made with ffmpeg. */
export type MockVideo = "storyboard" | "mp4";

const execute = promisify(execFile);

export interface MockExecutorOptions {
  jobs: JobStorePort;
  /** Decides whether a request should fail, and where, to exercise error paths without an account. */
  failure?: (request: GenerationInput) => { stage: MockStage; reason: string } | undefined;
  /**
   * A simulated price in USD per run, for exercising the spend policy offline: a priced run is quoted
   * at that amount, reserved like a paid run, and settles at it as reported credits. Never set by the app.
   */
  price?: (request: GenerationInput) => number | undefined;
  /** `mp4` makes real clips for video capabilities (see the module notes); storyboards by default. */
  video?: MockVideo;
  /**
   * A fixture transcription result for a `speech_to_text` request (this app's transcript shape or
   * Whisper's), instead of the prompt's words spread evenly. Tests only.
   */
  transcript?: (request: GenerationInput) => unknown;
  now?: () => number;
}

export interface Dimensions {
  width: number;
  height: number;
}

/** Escapes text for an SVG text node. */
export function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** Sample size from explicit width and height, else from the aspect ratio (9:16 by default). */
export function mockDimensions(input: GenerationInput): Dimensions {
  if (input.width && input.height) return { width: input.width, height: input.height };
  const ratio: AspectRatio = input.aspectRatio ?? "9:16";
  if (ratio === "9:16") return { width: 720, height: 1280 };
  if (ratio === "16:9") return { width: 1280, height: 720 };
  if (ratio === "1:1") return { width: 960, height: 960 };
  const value = ratioValue(ratio);
  const longEdge = 1152;
  const width = value >= 1 ? longEdge : Math.round((longEdge * value) / 16) * 16;
  const height = value >= 1 ? Math.round(longEdge / value / 16) * 16 : longEdge;
  return { width, height };
}

/** Renders a labeled placeholder: a still frame, or a three-panel storyboard for video capabilities. */
export function renderMockSvg(job: Pick<Job, "id" | "capability" | "request">): string {
  const { width, height } = mockDimensions(job.request.input);
  const video = capabilityMedia(job.capability) === "video";
  const prompt = job.request.input.prompt;
  const limit = width < 900 ? 28 : 54;
  const title = escapeXml(prompt.slice(0, limit)) + (prompt.length > limit ? "…" : "");
  const hue = (Number.parseInt(job.id.slice(0, 4), 16) % 50) + 190;
  const label = video ? "VIDEO STORYBOARD / STATIC SAMPLE" : "STILL FRAME / STATIC SAMPLE";
  const panels = video
    ? [
        `<path d="M ${width / 3} 100 V ${height - 170} M ${(width * 2) / 3} 100 V ${height - 170}" stroke="#fff" stroke-opacity=".35"/>`,
        `<text x="38" y="130" class="small">01 / OPEN</text>`,
        `<text x="${width / 3 + 20}" y="130" class="small">02 / HOLD</text>`,
        `<text x="${(width * 2) / 3 + 20}" y="130" class="small">03 / CLOSE</text>`,
      ].join("")
    : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Mock generation sample">`,
    `<defs><linearGradient id="sky" x2=".2" y2="1"><stop stop-color="hsl(${hue} 35% 19%)"/><stop offset="1" stop-color="#172321"/></linearGradient>`,
    `<radialGradient id="light"><stop stop-color="#f4c888" stop-opacity=".5"/><stop offset="1" stop-color="#f4c888" stop-opacity="0"/></radialGradient></defs>`,
    `<style>text{fill:#f4f1e8;font-family:Arial,sans-serif}.small{font-size:13px;letter-spacing:3px}.title{font-size:34px;font-weight:600}</style>`,
    `<rect width="${width}" height="${height}" fill="url(#sky)"/>`,
    `<circle cx="${width * 0.7}" cy="${height * 0.32}" r="${width * 0.4}" fill="url(#light)"/>`,
    `<circle cx="${width * 0.7}" cy="${height * 0.32}" r="42" fill="#f2cf96" opacity=".8"/>`,
    `<path d="M0 ${height * 0.65} L${width * 0.25} ${height * 0.38} L${width * 0.55} ${height * 0.75} L${width * 0.82} ${height * 0.48} L${width} ${height * 0.65} V${height} H0Z" fill="#15262a"/>`,
    `<path d="M0 ${height * 0.82} L${width * 0.36} ${height * 0.59} L${width * 0.62} ${height * 0.83} L${width} ${height * 0.67} V${height} H0Z" fill="#0d1a1d"/>`,
    `<rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="4" fill="none" stroke="#ffffff" stroke-opacity=".28"/>`,
    `<text x="42" y="65" class="small">AI CREATOR LAB</text>`,
    `<text x="${width - 42}" y="65" text-anchor="end" class="small">MOCK / NO AI</text>`,
    panels,
    `<rect x="25" y="${height - 154}" width="${width - 50}" height="129" fill="#0b1519" opacity=".9"/>`,
    `<text x="42" y="${height - 116}" class="small">${label}</text>`,
    `<text x="42" y="${height - 70}" class="title">${title}</text>`,
    `<text x="42" y="${height - 43}" class="small">${escapeXml(job.capability.toUpperCase())} · ${width}x${height}</text>`,
    `</svg>`,
  ].join("\n");
}

const MOCK_SAMPLE_RATE = 16_000;

/**
 * A labeled placeholder for speech: a soft two-tone hum as long as the text would take to say
 * (2.5 words per second, at least one second), as 16-bit mono WAV. Audible, so the silence check
 * passes, and obviously not a voice.
 */
export function renderMockWav(text: string): { bytes: Buffer; durationSeconds: number } {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const durationSeconds = Math.max(1, Math.round((words / 2.5) * 10) / 10);
  const samples = Math.round(durationSeconds * MOCK_SAMPLE_RATE);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    const t = index / MOCK_SAMPLE_RATE;
    const envelope = Math.min(1, t * 8, (durationSeconds - t) * 8) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    const tone = Math.sin(2 * Math.PI * 196 * t) * 0.6 + Math.sin(2 * Math.PI * 294 * t) * 0.3;
    data.writeInt16LE(Math.round(tone * envelope * 0.35 * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(MOCK_SAMPLE_RATE, 24);
  header.writeUInt32LE(MOCK_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return { bytes: Buffer.concat([header, data]), durationSeconds };
}

/** The mock's frame rate for real clips. */
export const MOCK_FPS = 24;

/** How long a mock clip runs: the requested seconds, else the frame count at 24 fps, else five seconds. */
export function mockSeconds(input: GenerationInput): number {
  const seconds = input.durationSeconds ?? (input.length ? input.length / MOCK_FPS : 5);
  return Math.round(Math.min(60, Math.max(0.5, seconds)) * 1000) / 1000;
}

/** An input file: absolute as given, or relative to the data directory and refused if it leaves it. */
function inputPath(root: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (isAbsolute(path)) return existsSync(path) ? path : undefined;
  const base = resolve(root);
  const absolute = resolve(base, path);
  if (!absolute.startsWith(base + sep)) return undefined;
  return existsSync(absolute) ? absolute : undefined;
}

/**
 * Renders a real mock clip into `absolute` through a temp file and returns its verified record.
 * The picture scrolls by 0.15 percent of its width per frame, so motion carries on across a seam.
 */
export async function renderMockMp4(job: Pick<Job, "capability" | "request">, absolute: string, relative: string, root: string): Promise<RetrievedFile> {
  const { input } = job.request;
  const seconds = mockSeconds(input).toFixed(3);
  const { width, height } = mockDimensions(input);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const [w, h] = [even(width), even(height)];
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp.mp4`;
  const base = `${absolute}.base.png`;
  try {
    const first = inputPath(root, input.images[0]);
    if (first) await sharp(first, { limitInputPixels: 40_000_000 }).resize(w, h, { fit: "cover" }).png().toFile(base);
    const voice = job.capability === "speech_to_video" ? inputPath(root, input.audio) : undefined;
    const video = first ? ["-loop", "1", "-framerate", String(MOCK_FPS), "-t", seconds, "-i", base] : ["-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=${MOCK_FPS}:duration=${seconds}`];
    const audio = voice ? ["-i", voice] : ["-f", "lavfi", "-i", `sine=frequency=220:sample_rate=48000:duration=${seconds}`];
    const args = [
      "-nostdin", "-v", "error", "-y", ...video, ...audio,
      "-map", "0:v:0", "-map", "1:a:0",
      // Exact colour conversion, so a clip started from another clip's handover frame keeps its level.
      "-sws_flags", "accurate_rnd+full_chroma_int",
      "-vf", `${first ? "scroll=horizontal=0.0015," : ""}format=yuv420p`,
      "-af", `apad=whole_dur=${seconds}`,
      "-t", seconds, "-r", String(MOCK_FPS),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
      "-movflags", "+faststart", temporary,
    ];
    await execute(ffmpegPath(), args, { env: childEnv(), timeout: 120_000, maxBuffer: 4_000_000 });
    const info = await probeVideo(temporary);
    await rename(temporary, absolute);
    return {
      relativePath: relative,
      mime: "video/mp4",
      width: info.width,
      height: info.height,
      sha256: sha256(await readFile(absolute)),
      video: { frames: info.frames, fps: info.fps, durationSeconds: info.durationSeconds, hasAudio: info.hasAudio },
    };
  } finally {
    await rm(temporary, { force: true });
    await rm(base, { force: true });
  }
}

/** The mock take's picture: steel blue, so a cutaway over it is easy to tell apart. */
export const MOCK_TAKE_COLOR = "0x46689a";

/**
 * Renders a mock take with ffmpeg: a 720 x 1280, 24 fps H.264 picture of one color with a grey bar
 * near the bottom (a flat frame would be refused as blank), and a 48 kHz AAC track of a tone that
 * rises and falls about three times a second, like syllables.
 */
export async function renderMockTake(path: string, durationSeconds: number): Promise<void> {
  const seconds = durationSeconds.toFixed(3);
  const picture = `color=c=${MOCK_TAKE_COLOR}:s=720x1280:r=24:d=${seconds},drawbox=x=40:y=1180:w=640:h=50:color=0xd0d0d0:t=fill`;
  const sound = `aevalsrc='0.35*sin(2*PI*190*t)*(0.55+0.45*sin(2*PI*3.3*t))':s=48000:d=${seconds}`;
  const args = [
    ["-nostdin", "-v", "error", "-y"],
    ["-f", "lavfi", "-i", picture],
    ["-f", "lavfi", "-i", sound],
    ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"],
    ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "1"],
    ["-t", seconds, "-movflags", "+faststart", "-f", "mp4", path],
  ].flat();
  await execute(ffmpegPath(), args, { env: childEnv(), timeout: 60_000, maxBuffer: 1_000_000 });
}

/**
 * The mock transcription: the prompt's words (the script's lines, which the transcription step
 * sends as Whisper's vocabulary) spread evenly from 0.3 s to 0.3 s before the end.
 */
export function mockTranscript(prompt: string, durationSeconds: number): Transcript {
  const words = prompt.trim().split(/\s+/).filter(Boolean).slice(0, 2000);
  const start = Math.min(0.3, durationSeconds / 10);
  const slot = words.length ? (durationSeconds - 2 * start) / words.length : 0;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return parseTranscript({
    language: "en",
    durationSeconds: round(durationSeconds),
    text: words.join(" "),
    words: words.map((text, index) => ({ text: text.slice(0, 64), start: round(start + index * slot), end: round(start + index * slot + slot * 0.8) })),
  });
}

export class MockExecutor implements Executor {
  readonly kind = "mock" as const;
  private readonly jobs: JobStorePort;
  private readonly failure: MockExecutorOptions["failure"];
  private readonly price: MockExecutorOptions["price"];
  private readonly transcript: MockExecutorOptions["transcript"];
  private readonly now: () => number;
  /** Whether video jobs make real MP4 clips (chained recordings need them). */
  readonly video: MockVideo;

  constructor(options: MockExecutorOptions) {
    this.jobs = options.jobs;
    this.failure = options.failure;
    this.price = options.price;
    this.video = options.video ?? "storyboard";
    this.transcript = options.transcript;
    this.now = options.now ?? Date.now;
  }

  async estimate(request?: { input: GenerationInput }): Promise<EstimateOutcome> {
    const usd = request ? this.price?.(request.input) : undefined;
    if (usd !== undefined && usd > 0) {
      return { kind: "quoted", usd, credits: usdToCredits(usd), source: "live", note: "Simulated price (mock run, nothing is charged)." };
    }
    return { kind: "free", note: "Mock samples are free and labeled; nothing is generated." };
  }

  async submit(job: Job): Promise<SubmitOutcome> {
    try {
      if (job.request.recipe.kind !== "mock") throw new ExecutorFailure(jobError("invalid", "The mock executor runs mock recipes only."));
      const claimed = claimForSubmit(this.jobs, job, this.now());
      if (!claimed) return { kind: "existing", job: loadJob(this.jobs, job.id) };
      const failure = this.failure?.(claimed.request.input);
      if (failure?.stage === "submit") {
        const error = jobError("provider", failure.reason);
        return { kind: "failed", job: failJob(this.jobs, claimed, error, this.now()), error };
      }
      return { kind: "accepted", job: claimed };
    } catch (cause) {
      return { kind: "failed", job: this.jobs.get(job.id) ?? null, error: toJobError(cause) };
    }
  }

  async poll(jobId: string): Promise<PollOutcome> {
    const job = loadJob(this.jobs, jobId);
    if (job.status === "completed") return { kind: "completed", job };
    if (job.status === "failed") return { kind: "failed", job, error: job.error };
    if (job.status === "retrieving") return { kind: "ready", job };
    const failure = this.failure?.(job.request.input);
    if (failure?.stage === "poll") {
      const error = jobError("provider", failure.reason);
      return { kind: "failed", job: failJob(this.jobs, job, error, this.now()), error };
    }
    return { kind: "ready", job: transition(this.jobs, job, { status: "retrieving", providerRef: `mock-${job.id}` }, this.now()) };
  }

  async retrieve(jobId: string, destination: RetrieveDestination): Promise<RetrieveOutcome> {
    const job = loadJob(this.jobs, jobId);
    if (job.status === "failed") return { kind: "failed", job, error: job.error };
    if (job.status === "completed" || (job.status === "retrieving" && job.retrieved.length > 0)) return { kind: "completed", job, metrics: null };
    if (job.status !== "retrieving") return { kind: "not_ready", job };
    const failure = this.failure?.(job.request.input);
    if (failure?.stage === "retrieve") {
      const error = jobError("provider", failure.reason);
      return { kind: "failed", job: failJob(this.jobs, job, error, this.now()), error };
    }
    const priced = this.price?.(job.request.input);
    const creditsUsed = priced !== undefined && priced > 0 ? usdToCredits(priced) : 0;
    const real = await this.realOutput(job, destination).catch((cause) => {
      const error = toJobError(cause);
      return { failed: error };
    });
    if (real && "failed" in real) return { kind: "failed", job: failJob(this.jobs, job, real.failed, this.now()), error: real.failed };
    if (real) return { kind: "completed", job: patchJob(this.jobs, job, { retrieved: [real], creditsUsed, notice: null }, this.now()), metrics: null };
    if (this.video === "mp4" && capabilityMedia(job.capability) === "video") {
      const { absolute, relative } = outputLocation(destination, `${job.id}-0.mp4`);
      try {
        const output = await renderMockMp4(job, absolute, relative, destination.root);
        return { kind: "completed", job: patchJob(this.jobs, job, { retrieved: [output], creditsUsed, notice: null }, this.now()), metrics: null };
      } catch {
        const error = jobError("provider", "The mock clip could not be made. Check that ffmpeg is installed.", true);
        return { kind: "retry", job, retryAfterMs: 1000, error };
      }
    }
    const speech = capabilityMedia(job.capability) === "audio";
    const wav = speech ? renderMockWav(job.request.input.prompt) : undefined;
    const bytes = wav ? wav.bytes : Buffer.from(renderMockSvg(job), "utf8");
    const { width, height } = mockDimensions(job.request.input);
    const { absolute, relative } = outputLocation(destination, `${job.id}-0.${wav ? "wav" : "svg"}`);
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp`;
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, absolute);
    } finally {
      await rm(temporary, { force: true });
    }
    const output: RetrievedFile = wav
      ? { relativePath: relative, mime: "audio/wav", width: 0, height: 0, sha256: sha256(bytes), audio: { durationSeconds: wav.durationSeconds, codec: "pcm_s16le" } }
      : { relativePath: relative, mime: "image/svg+xml", width, height, sha256: sha256(bytes) };
    const saved = patchJob(this.jobs, job, { retrieved: [output], creditsUsed, notice: null }, this.now());
    return { kind: "completed", job: saved, metrics: null };
  }

  /** The take and the transcript, the two mock outputs that are real files; undefined for every other job. */
  private async realOutput(job: Job, destination: RetrieveDestination): Promise<RetrievedFile | undefined> {
    const target = job.request.target;
    if (target.kind === "take" && target.slot === "clip" && capabilityMedia(job.capability) === "video") {
      const { absolute, relative } = outputLocation(destination, `${job.id}-0.mp4`);
      const temporary = await tempBeside(absolute);
      try {
        await renderMockTake(temporary, job.request.input.durationSeconds ?? 5);
      } catch {
        await rm(temporary, { force: true });
        throw new ExecutorFailure(jobError("invalid", "The mock talking recording needs FFmpeg. Install it or set FFMPEG_PATH, then try again."));
      }
      return commitOutput(temporary, absolute, relative, { media: "video" });
    }
    if (job.capability !== "speech_to_text") return undefined;
    const recording = job.request.input.audio ?? job.request.input.images[0];
    if (!recording) throw new ExecutorFailure(jobError("invalid", "A transcription needs the recording to transcribe."));
    const path = isAbsolute(recording) ? recording : resolve(destination.root, recording);
    const durationSeconds = await probeVideo(path)
      .then((info) => info.durationSeconds)
      .catch(() => probeAudio(path).then((info) => info.durationSeconds))
      .catch(() => {
        throw new ExecutorFailure(jobError("invalid", "The recording to transcribe could not be read. Check that ffmpeg and ffprobe are installed."));
      });
    const fixture = this.transcript?.(job.request.input);
    let transcript: Transcript;
    try {
      transcript = fixture === undefined ? mockTranscript(job.request.input.prompt, durationSeconds) : parseTranscript(fixture, durationSeconds);
    } catch (cause) {
      // The parser's words are meant for a person ("found no words in the recording"); keep them.
      throw new ExecutorFailure(jobError("invalid", cause instanceof Error ? cause.message.slice(0, 1000) : "The transcription result could not be read."));
    }
    const bytes = Buffer.from(JSON.stringify(transcript, null, 2), "utf8");
    const { absolute, relative } = outputLocation(destination, `${job.id}-0.json`);
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp`;
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, absolute);
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      relativePath: relative,
      mime: "application/json",
      width: 0,
      height: 0,
      sha256: sha256(bytes),
      transcription: { durationSeconds: transcript.durationSeconds, wordCount: transcript.words.length, language: transcript.language },
    };
  }

  async cancel(jobId: string): Promise<CancelOutcome> {
    const job = loadJob(this.jobs, jobId);
    if (job.status === "completed" || job.status === "failed" || job.status === "retrieving") return { kind: "too_late", job };
    const error = jobError("invalid", "Canceled before it finished.", false, "canceled");
    return { kind: "canceled", job: failJob(this.jobs, job, error, this.now()) };
  }
}
