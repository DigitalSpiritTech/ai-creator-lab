/**
 * Router executor: runs hosted partner models through `comfy.models.run` with the job id as idempotency
 * key. The body is built from the recipe's semantic field map and checked against the model's published
 * schema; results are parsed per model family and downloaded immediately (Router keeps outputs for 24
 * hours). A lost response is collected again under the same key, which Router replays without charging twice.
 * @packageDocumentation
 */
import { comfy, ComfyError, type RunResult } from "@comfyorg/sdk";
import { rm, writeFile } from "node:fs/promises";
import { capabilityMedia, checkAgainstSchema, ratioValue, requestBodySchema, type RouterRecipe } from "@/lib/catalog";
import {
  backoffMs,
  claimRequest,
  ExecutorFailure,
  failJob,
  jobError,
  loadJob,
  toJobError,
  transition,
  type JobPatch,
} from "@/server/executors/jobs";
import { commitOutput, outputLocation, tempBeside, type OutputExpectation } from "@/server/executors/media";
import { buildRouterBody, prepareImages } from "@/server/executors/router-body";
import { downloadMedia, productionMediaPorts, type MediaPorts } from "@/server/executors/router-download";
import { extractRouterMedia, routerFamily, type RouterMedia } from "@/server/executors/router-output";
import {
  GenerationRequestSchema,
  type EstimateOutcome,
  type Executor,
  type GenerationRequest,
  type JobError,
  type JobRecord,
  type JobRepository,
  type PollOutcome,
  type RetrieveDestination,
  type RetrieveOutcome,
  type SubmitOutcome,
} from "@/server/executors/types";

/** The slice of `comfy.models` this executor uses; tests substitute a fake with recorded responses. */
export interface RouterModelsPort {
  run(model: string, input: Record<string, unknown>, options?: { idempotencyKey?: string; maxBytes?: number | null }): Promise<RunResult>;
}

/** The real Router namespace. Credentials are process-global in the SDK, which suits this single-user app. */
export function createRouterModels(apiKey: string): RouterModelsPort {
  comfy.config({ credentials: apiKey });
  return comfy.models;
}

const RECOVERY_WINDOW_MS = 23 * 60 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RESULT_BYTES = 256 * 1024 * 1024;

type Classified = { outcome: "failed"; error: JobError } | { outcome: "uncertain"; notice: string };

/** Maps a `comfy.models.run` failure to a terminal failure or an uncertain submission. */
export function classifyRouterError(cause: unknown): Classified {
  if (!(cause instanceof ComfyError)) {
    return { outcome: "uncertain", notice: "Router did not answer. The request will be collected with the same idempotency key; it is never charged twice." };
  }
  const code = cause.code ?? "";
  const reason = cause.message.slice(0, 300);
  const failed = (error: JobError): Classified => ({ outcome: "failed", error });
  switch (code) {
    case "content_policy_violation":
      return failed(jobError("provider", `The provider declined this request: ${reason}`, false, code));
    case "invalid_input":
      return failed(jobError("invalid", `Router rejected these settings: ${reason}`, false, code));
    case "insufficient_credits":
      return failed(jobError("budget", "Your Comfy account needs more credits before this model can run.", false, code));
    case "unauthorized":
    case "forbidden":
      return failed(jobError("provider", "Comfy rejected the API key, or it is not allowed to use this model.", false, code));
    case "not_enabled":
      return failed(jobError("provider", "Comfy Router is not enabled for this account yet.", false, code));
    case "model_not_found":
    case "not_found":
      return failed(jobError("provider", "Router does not list this model any more. Pick another recipe.", false, code));
    case "provider_error":
      return failed(jobError("provider", `The provider reported an error: ${reason}`, true, code));
    case "rate_limited":
      return failed(jobError("provider", "Router is rate limiting this account. Try again shortly.", true, code));
    default:
      break;
  }
  if (cause.httpStatus !== undefined && cause.httpStatus >= 400 && cause.httpStatus < 500 && cause.httpStatus !== 408 && cause.httpStatus !== 409) {
    return failed(jobError("provider", `Router refused the request: ${reason}`, false, code || undefined));
  }
  return { outcome: "uncertain", notice: "Router's answer is not confirmed yet. The request will be collected with the same idempotency key; it is never charged twice." };
}

/** Parses `X-Comfy-Credits-Used`; null means not reported, never free. */
export function parseCredits(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const credits = Number(value);
  return Number.isFinite(credits) && credits >= 0 ? credits : null;
}

function extensionFor(bytes: Uint8Array, media: "image" | "video"): string {
  if (media === "video") return "mp4";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP") return "webp";
  return "png";
}

export interface RouterExecutorOptions {
  repository: JobRepository;
  models: RouterModelsPort;
  mediaPorts?: MediaPorts;
  /** Live price check; without one, estimates fall back to the recipe ceiling. */
  quote?: (model: string, body: Record<string, unknown>) => Promise<EstimateOutcome>;
  /** The model's published OpenAPI document, from the catalog cache, used to validate bodies. */
  schemaFor?: (model: string) => Promise<unknown | undefined>;
  /** Uploads a local file and returns a short-lived URL, for models that take images by URL. */
  assetUrl?: (path: string) => Promise<string>;
  now?: () => number;
  staleSubmitMs?: number;
}

export class RouterExecutor implements Executor {
  readonly kind = "router" as const;
  private readonly repository: JobRepository;
  private readonly models: RouterModelsPort;
  private readonly mediaPorts: MediaPorts;
  private readonly options: RouterExecutorOptions;
  private readonly now: () => number;
  private readonly staleSubmitMs: number;
  /** Parsed results awaiting download; rebuilt by a same-key replay after a restart. */
  private readonly pending = new Map<string, RouterMedia>();
  private readonly attempts = new Map<string, number>();

  constructor(options: RouterExecutorOptions) {
    this.options = options;
    this.repository = options.repository;
    this.models = options.models;
    this.mediaPorts = options.mediaPorts ?? productionMediaPorts;
    this.now = options.now ?? Date.now;
    this.staleSubmitMs = options.staleSubmitMs ?? 120_000;
  }

  async estimate(request: GenerationRequest): Promise<EstimateOutcome> {
    try {
      const parsed = GenerationRequestSchema.parse(request);
      const recipe = this.recipeOf(parsed);
      const body = await this.body(recipe, parsed.input);
      if (!this.options.quote) return { kind: "unquoted", ceilingUsd: recipe.ceilingUsd ?? null, note: recipe.costHint };
      const quote = await this.options.quote(recipe.model, body);
      return quote.kind === "unquoted" ? { ...quote, ceilingUsd: quote.ceilingUsd ?? recipe.ceilingUsd ?? null } : quote;
    } catch (cause) {
      return { kind: "rejected", error: toJobError(cause) };
    }
  }

  async submit(request: GenerationRequest): Promise<SubmitOutcome> {
    try {
      const parsed = GenerationRequestSchema.parse(request);
      const recipe = this.recipeOf(parsed);
      const body = await this.body(recipe, parsed.input);
      const claim = await claimRequest(this.repository, parsed, "submitting", this.now());
      if (!claim.created) return { kind: "existing", job: claim.job };
      return await this.execute(claim.job, body);
    } catch (cause) {
      return { kind: "failed", job: null, error: toJobError(cause) };
    }
  }

  async poll(jobId: string): Promise<PollOutcome> {
    const job = await loadJob(this.repository, jobId);
    if (job.status === "completed") return { kind: "completed", job };
    if (job.status === "failed") return { kind: "failed", job, error: job.error ?? jobError("provider", "This job failed.") };
    if (job.status === "retrieving") return { kind: "ready", job };
    if (job.status === "submitting" && this.now() - job.updatedAt < this.staleSubmitMs) {
      return { kind: "pending", job, retryAfterMs: 5000, queuePosition: null };
    }
    if (this.now() - job.createdAt > RECOVERY_WINDOW_MS) {
      const notice = "This request could not be confirmed within a day. It will not be sent again; check your Comfy usage before generating again.";
      const saved = job.status === "uncertain" && job.notice === notice ? job : await this.save(job, { status: "uncertain", notice });
      return { kind: "uncertain", job: saved, retryAfterMs: 60 * 60_000 };
    }
    const claimed = await this.save(job, { status: "submitting" });
    const outcome = await this.execute(claimed);
    if (outcome.kind === "failed") return { kind: "failed", job: outcome.job ?? (await loadJob(this.repository, jobId)), error: outcome.error };
    if (outcome.kind === "uncertain") return { kind: "uncertain", job: outcome.job, retryAfterMs: this.delay(jobId) };
    return outcome.job.status === "retrieving" ? { kind: "ready", job: outcome.job } : { kind: "pending", job: outcome.job, retryAfterMs: this.delay(jobId), queuePosition: null };
  }

  async retrieve(jobId: string, destination: RetrieveDestination): Promise<RetrieveOutcome> {
    const job = await loadJob(this.repository, jobId);
    if (job.status === "completed") return { kind: "completed", job, metrics: null };
    if (job.status === "failed") return { kind: "failed", job, error: job.error ?? jobError("provider", "This job failed.") };
    if (job.status !== "retrieving") return { kind: "not_ready", job };
    const recipe = this.recipeOf(job.request);
    const media = capabilityMedia(recipe.capability);
    if (media === "text") return this.retrieveFailed(job, jobError("invalid", "Text models are not retrieved as media."));
    try {
      const found = this.pending.get(job.id) ?? (await this.replay(job));
      const bytes = found.kind === "inline" ? found.bytes : await downloadMedia(found.url, this.mediaPorts);
      const { absolute, relative } = outputLocation(destination, `${job.id}-0.${extensionFor(bytes, media)}`);
      const temporary = await tempBeside(absolute);
      const aspect = job.request.input.aspectRatio ?? recipe.defaults.aspectRatio;
      const expectation: OutputExpectation = { media, ratio: aspect ? ratioValue(aspect) : undefined };
      try {
        await writeFile(temporary, bytes);
      } catch (cause) {
        await rm(temporary, { force: true });
        throw cause;
      }
      const output = await commitOutput(temporary, absolute, relative, expectation);
      const completed = await this.save(job, { status: "completed", outputs: [output], notice: null, error: null });
      this.pending.delete(job.id);
      this.attempts.delete(job.id);
      return { kind: "completed", job: completed, metrics: null };
    } catch (cause) {
      const error = toJobError(cause, "The output could not be saved. Retrieval will retry without generating again.");
      if (error.retryable && this.now() - job.createdAt > RETENTION_MS) {
        return this.retrieveFailed(job, jobError("provider", "Router's 24-hour output retention has passed; this output can no longer be downloaded.", false, "expired"));
      }
      return this.retrieveFailed(job, error);
    }
  }

  private recipeOf(request: Pick<GenerationRequest, "recipe">): RouterRecipe {
    if (request.recipe.kind !== "router") throw new ExecutorFailure(jobError("invalid", "The Router executor runs Router recipes only."));
    return request.recipe;
  }

  /** Builds the native body and checks it against the model's published schema when one is cached. */
  private async body(recipe: RouterRecipe, input: GenerationRequest["input"]): Promise<Record<string, unknown>> {
    const images = await prepareImages(input.images, recipe, this.options.assetUrl);
    const body = buildRouterBody(recipe, input, images);
    const document = await this.options.schemaFor?.(recipe.model).catch(() => undefined);
    const schema = document ? requestBodySchema(document) : undefined;
    if (schema) {
      const problems = checkAgainstSchema(body, schema, document);
      if (problems.length) throw new ExecutorFailure(jobError("invalid", `The request does not fit ${recipe.model}: ${problems.slice(0, 3).join(" ")}`));
    }
    return body;
  }

  private async run(job: JobRecord, body?: Record<string, unknown>): Promise<RunResult> {
    const recipe = this.recipeOf(job.request);
    const native = body ?? (await this.body(recipe, job.request.input));
    return this.models.run(recipe.model, native, { idempotencyKey: job.id, maxBytes: MAX_RESULT_BYTES });
  }

  /** Sends (or re-collects) the request and records what came back. */
  private async execute(job: JobRecord, body?: Record<string, unknown>): Promise<SubmitOutcome> {
    const recipe = this.recipeOf(job.request);
    let result: RunResult;
    try {
      result = await this.run(job, body);
    } catch (cause) {
      if (cause instanceof ExecutorFailure) {
        return { kind: "failed", job: await failJob(this.repository, job, cause.failure, this.now()), error: cause.failure };
      }
      const classified = classifyRouterError(cause);
      if (classified.outcome === "failed") return { kind: "failed", job: await failJob(this.repository, job, classified.error, this.now()), error: classified.error };
      return { kind: "uncertain", job: await this.save(job, { status: "uncertain", notice: classified.notice }) };
    }
    const creditsUsed = parseCredits(result.creditsUsed) ?? job.creditsUsed;
    const providerRef = result.requestId ?? job.providerRef;
    let media: RouterMedia;
    try {
      media = extractRouterMedia(routerFamily(recipe), result);
    } catch (cause) {
      const error = toJobError(cause);
      const failed = await this.save(job, { status: "failed", error, providerRef, creditsUsed, notice: null });
      return { kind: "failed", job: failed, error };
    }
    this.pending.set(job.id, media);
    return { kind: "accepted", job: await this.save(job, { status: "retrieving", providerRef, creditsUsed, notice: null }) };
  }

  /** After a restart the parsed result is gone; the same key returns the stored result at no extra charge. */
  private async replay(job: JobRecord): Promise<RouterMedia> {
    let result: RunResult;
    try {
      result = await this.run(job);
    } catch (cause) {
      if (cause instanceof ExecutorFailure) throw cause;
      const classified = classifyRouterError(cause);
      throw new ExecutorFailure(classified.outcome === "failed" ? classified.error : jobError("provider", classified.notice, true));
    }
    return extractRouterMedia(routerFamily(this.recipeOf(job.request)), result);
  }

  private delay(jobId: string): number {
    const attempt = this.attempts.get(jobId) ?? 0;
    this.attempts.set(jobId, attempt + 1);
    return backoffMs(attempt);
  }

  private async save(job: JobRecord, patch: JobPatch): Promise<JobRecord> {
    let current = job;
    for (let attempt = 0; ; attempt++) {
      try {
        return await transition(this.repository, current, patch, this.now());
      } catch (cause) {
        if (!(cause instanceof ExecutorFailure) || cause.failure.code !== "conflict" || attempt >= 2) throw cause;
        current = await loadJob(this.repository, job.id);
        if (current.status === "completed" || current.status === "failed") return current;
      }
    }
  }

  private async retrieveFailed(job: JobRecord, error: JobError): Promise<RetrieveOutcome> {
    if (error.retryable) {
      const saved = await this.save(job, { status: "retrieving", notice: error.message });
      return { kind: "retry", job: saved, retryAfterMs: this.delay(job.id), error };
    }
    return { kind: "failed", job: await failJob(this.repository, job, error, this.now()), error };
  }
}
