/**
 * Credit-free executor: deterministic, visibly labeled SVG stills for image capabilities and static
 * storyboard plates for video capabilities, with an optional simulated failure. No network.
 * @packageDocumentation
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { capabilityMedia, ratioValue, type AspectRatio } from "@/lib/catalog";
import {
  ExecutorFailure,
  claimForSubmit,
  failJob,
  jobError,
  loadJob,
  patchJob,
  toJobError,
  transition,
} from "@/server/executors/jobs";
import { outputLocation, sha256 } from "@/server/executors/media";
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
} from "@/server/executors/types";

export type MockStage = "submit" | "poll" | "retrieve";

export interface MockExecutorOptions {
  jobs: JobStorePort;
  /** Decides whether a request should fail, and where, to exercise error paths without an account. */
  failure?: (request: GenerationInput) => { stage: MockStage; reason: string } | undefined;
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

export class MockExecutor implements Executor {
  readonly kind = "mock" as const;
  private readonly jobs: JobStorePort;
  private readonly failure: MockExecutorOptions["failure"];
  private readonly now: () => number;

  constructor(options: MockExecutorOptions) {
    this.jobs = options.jobs;
    this.failure = options.failure;
    this.now = options.now ?? Date.now;
  }

  async estimate(): Promise<EstimateOutcome> {
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
    const saved = patchJob(this.jobs, job, { retrieved: [output], creditsUsed: 0, notice: null }, this.now());
    return { kind: "completed", job: saved, metrics: null };
  }

  async cancel(jobId: string): Promise<CancelOutcome> {
    const job = loadJob(this.jobs, jobId);
    if (job.status === "completed" || job.status === "failed" || job.status === "retrieving") return { kind: "too_late", job };
    const error = jobError("invalid", "Canceled before it finished.", false, "canceled");
    return { kind: "canceled", job: failJob(this.jobs, job, error, this.now()) };
  }
}
