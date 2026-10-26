/**
 * Workflow executor: runs an API-format ComfyUI workflow plus its slot sidecar through `@comfyorg/sdk`
 * against COMFY_BASE_URL (blank means Comfy Cloud). Submits once with the job id as idempotency key,
 * saves the provider job id immediately, polls authoritatively, and copies verified outputs locally
 * before the signed URLs expire.
 * @packageDocumentation
 */
import {
  BlobNotFound,
  Comfy,
  ComfyError,
  Forbidden,
  HashMismatch,
  IdempotencyKeyReuse,
  InsufficientCredits,
  InvalidWorkflow,
  MissingAsset,
  MissingCredentials,
  NotFound,
  QueueFull,
  Unauthorized,
} from "@comfyorg/sdk";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applySlots,
  capabilityMedia,
  imageSlotNames,
  ratioValue,
  sidecarProblems,
  slotDefault,
  snapLength,
  WorkflowGraphSchema,
  type SlotValue,
  type WorkflowGraph,
  type WorkflowRecipe,
} from "@/lib/catalog";
import { fitImage } from "@/server/executors/image-prep";
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
import {
  GenerationRequestSchema,
  type CancelOutcome,
  type EstimateOutcome,
  type Executor,
  type GenerationInput,
  type GenerationRequest,
  type JobError,
  type JobMetrics,
  type JobOutput,
  type JobRecord,
  type JobRepository,
  type PollOutcome,
  type RetrieveDestination,
  type RetrieveOutcome,
  type SubmitOutcome,
} from "@/server/executors/types";
import { usdToCredits } from "@/server/executors/allowance";

/** The slice of the SDK this executor uses; tests substitute a fake with recorded responses. */
export interface WorkflowClient {
  workflows: { fromJson(graph: Record<string, unknown>): WorkflowHandle };
  assets: { fromFile(path: string): unknown };
  submit(workflow: WorkflowHandle, options: { idempotencyKey: string }): Promise<CloudJobHandle>;
  jobs: { get(jobId: string): Promise<CloudJobHandle> };
}

export interface WorkflowHandle {
  json: Record<string, unknown>;
  setInput(nodeId: string, field: string, value: unknown): void;
}

export interface CloudJobHandle {
  readonly id: string;
  readonly status: string;
  readonly error: unknown;
  readonly queuePosition: number | null;
  readonly metrics: unknown;
  getOutputs(nodeId: string): CloudOutputHandle[];
  cancel(): Promise<unknown>;
}

export interface CloudOutputHandle {
  readonly type: string;
  readonly contentType: string;
  toFile(path: string): Promise<string>;
}

/** The real SDK client; COMFY_BASE_URL decides Cloud, a deployment, or a local proxy. */
export function createWorkflowClient(apiKey: string | undefined): WorkflowClient {
  return new Comfy({ apiKey: apiKey || undefined, clientInfo: "ai-creator-lab" });
}

const RECOVERY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Deterministic default seed so a recovered submission sends exactly the same graph. */
export function seedFromId(id: string): number {
  return Number.parseInt(id.replaceAll("-", "").slice(0, 8), 16);
}

export interface WorkflowPlan {
  values: Record<string, SlotValue>;
  images: { slot: string; path: string }[];
  width?: number;
  height?: number;
  length?: number;
  expectation: OutputExpectation;
}

function invalid(message: string): ExecutorFailure {
  return new ExecutorFailure(jobError("invalid", message));
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickSize(recipe: WorkflowRecipe, input: GenerationInput, graph: WorkflowGraph): { width?: number; height?: number } {
  const { sidecar } = recipe;
  if (!sidecar.slots.width || !sidecar.slots.height) return {};
  if (input.width !== undefined || input.height !== undefined) {
    if (input.width === undefined || input.height === undefined) throw invalid("Give both width and height.");
    return { width: input.width, height: input.height };
  }
  const sizes = sidecar.limits.sizes ?? recipe.limits.sizes ?? [];
  if (input.aspectRatio) {
    const ratio = ratioValue(input.aspectRatio);
    const match = sizes.find(([width, height]) => Math.abs(width / height - ratio) < ratio * 0.02);
    if (!match) throw invalid(`${recipe.title} has no preset size for ${input.aspectRatio}.`);
    return { width: match[0], height: match[1] };
  }
  return {
    width: recipe.defaults.width ?? numeric(slotDefault(sidecar, graph, "width")),
    height: recipe.defaults.height ?? numeric(slotDefault(sidecar, graph, "height")),
  };
}

/**
 * Resolves semantic inputs into slot values for one recipe, validating counts, sizes, and lengths.
 * Image slots carry local paths here; the executor swaps them for uploaded asset handles.
 */
export function planWorkflow(recipe: WorkflowRecipe, input: GenerationInput, graph: WorkflowGraph, fallbackSeed: number): WorkflowPlan {
  const { sidecar } = recipe;
  const values: Record<string, SlotValue> = {};
  if (!sidecar.slots.prompt) throw invalid(`${recipe.title} has no prompt slot.`);
  values.prompt = input.prompt;

  const imageSlots = imageSlotNames(sidecar);
  if (input.images.length !== imageSlots.length) {
    throw invalid(`${recipe.title} takes ${imageSlots.length} reference image${imageSlots.length === 1 ? "" : "s"}; ${input.images.length} given.`);
  }
  const images = imageSlots.map((slot, index) => ({ slot, path: input.images[index] }));

  const { width, height } = pickSize(recipe, input, graph);
  if (width !== undefined && height !== undefined) {
    const multiple = sidecar.limits.multipleOf;
    const sizes = sidecar.limits.sizes;
    if (multiple ? width % multiple !== 0 || height % multiple !== 0 : sizes && !sizes.some(([w, h]) => w === width && h === height)) {
      throw invalid(`${width}x${height} is not a size ${recipe.title} supports.`);
    }
    values.width = width;
    values.height = height;
  }

  let length: number | undefined;
  if (sidecar.slots.length) {
    const rule = sidecar.limits.length?.rule;
    const fps = sidecar.limits.fps ?? recipe.limits.fps;
    if (input.length !== undefined) {
      if (snapLength(input.length, rule) !== input.length) throw invalid(`A length of ${input.length} frames breaks the ${rule} rule.`);
      length = input.length;
    } else if (input.durationSeconds !== undefined && fps) {
      length = snapLength(input.durationSeconds * fps, rule);
    } else {
      length = recipe.defaults.length ?? sidecar.limits.length?.default ?? numeric(slotDefault(sidecar, graph, "length"));
    }
    if (length !== undefined) values.length = length;
  }

  if (sidecar.slots.seed) values.seed = input.seed ?? fallbackSeed;

  const reserved = new Set(["prompt", "width", "height", "length", "seed", ...imageSlots]);
  for (const [name, value] of Object.entries(input.slots ?? {})) {
    if (reserved.has(name)) throw invalid(`Set ${name} through its own field, not as an extra slot.`);
    if (!sidecar.slots[name]) throw invalid(`${recipe.title} has no slot named ${name}.`);
    values[name] = value;
  }

  const media = capabilityMedia(recipe.capability);
  if (media === "text") throw invalid("Text workflows are not supported by this executor yet.");
  const expectation: OutputExpectation =
    media === "image"
      ? { media, width, height }
      : { media, width, height, frames: length, fps: sidecar.limits.fps ?? recipe.limits.fps };
  return { values, images, width, height, length, expectation };
}

/** Maps a Cloud job status to the job record's status. */
export function cloudStatus(status: string): "queued" | "running" | "retrieving" | "failed" {
  if (status === "succeeded" || status === "completed") return "retrieving";
  if (status === "queued" || status === "pending") return "queued";
  if (["failed", "canceled", "cancelled", "expired", "error"].includes(status)) return "failed";
  return "running";
}

function cloudJobError(status: string, error: unknown): JobError {
  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const where = typeof detail.class_type === "string" ? ` in ${detail.class_type}${typeof detail.node_id === "string" ? ` (node ${detail.node_id})` : ""}` : "";
  const message = typeof detail.message === "string" ? `: ${detail.message.slice(0, 300)}` : ".";
  if (status === "expired") return jobError("provider", "Comfy expired this job before it finished.", true, "expired");
  if (status === "canceled" || status === "cancelled") return jobError("provider", "This job was canceled in Comfy.", false, "canceled");
  return jobError("provider", `Comfy could not run the workflow${where}${message}`, false, typeof detail.code === "string" ? detail.code : undefined);
}

type Classified = { outcome: "failed"; error: JobError } | { outcome: "uncertain"; notice: string };

/** Decides whether a submit error proves nothing ran (failed) or leaves the outcome unknown (uncertain). */
export function classifySubmitError(cause: unknown): Classified {
  if (cause instanceof InsufficientCredits) return { outcome: "failed", error: jobError("budget", "Your Comfy account needs more credits before this workflow can run.") };
  if (cause instanceof Unauthorized || cause instanceof Forbidden || cause instanceof MissingCredentials) {
    return { outcome: "failed", error: jobError("provider", "Comfy rejected the API key, or this account cannot run workflows (API access needs a paid Cloud plan).") };
  }
  if (cause instanceof InvalidWorkflow || cause instanceof MissingAsset || cause instanceof HashMismatch || cause instanceof BlobNotFound) {
    return { outcome: "failed", error: jobError("invalid", `Comfy rejected the workflow: ${cause.message.slice(0, 300)}`) };
  }
  if (cause instanceof QueueFull) return { outcome: "failed", error: jobError("provider", "Comfy's queue is full. Try again in a minute.", true, "queue_full") };
  if (cause instanceof ComfyError && cause.httpStatus !== undefined && cause.httpStatus >= 400 && cause.httpStatus < 500) {
    return { outcome: "failed", error: jobError("provider", `Comfy refused the submission: ${cause.message.slice(0, 300)}`, false, cause.code) };
  }
  return {
    outcome: "uncertain",
    notice: "The submission's result is unknown. It will be checked with the same idempotency key before anything is sent again.",
  };
}

export interface WorkflowExecutorOptions {
  repository: JobRepository;
  client: WorkflowClient;
  /** Folder holding `*.api.json` files; defaults to `<cwd>/workflows`. */
  workflowsDir?: string;
  now?: () => number;
  /** How long a `submitting` job may sit before poll treats it as abandoned. */
  staleSubmitMs?: number;
}

export class WorkflowExecutor implements Executor {
  readonly kind = "workflow" as const;
  private readonly repository: JobRepository;
  private readonly client: WorkflowClient;
  private readonly workflowsDir: string;
  private readonly now: () => number;
  private readonly staleSubmitMs: number;
  private readonly pollCounts = new Map<string, number>();

  constructor(options: WorkflowExecutorOptions) {
    this.repository = options.repository;
    this.client = options.client;
    this.workflowsDir = options.workflowsDir ?? resolve(process.cwd(), "workflows");
    this.now = options.now ?? Date.now;
    this.staleSubmitMs = options.staleSubmitMs ?? 120_000;
  }

  async estimate(request: GenerationRequest): Promise<EstimateOutcome> {
    try {
      const parsed = GenerationRequestSchema.parse(request);
      const recipe = this.recipeOf(parsed);
      planWorkflow(recipe, parsed.input, await this.loadGraph(recipe), 0);
      if (recipe.ceilingUsd === undefined) return { kind: "unquoted", ceilingUsd: null, note: recipe.costHint };
      return { kind: "quoted", usd: recipe.ceilingUsd, credits: usdToCredits(recipe.ceilingUsd), source: "hint", note: recipe.costHint };
    } catch (cause) {
      return { kind: "rejected", error: toJobError(cause) };
    }
  }

  async submit(request: GenerationRequest): Promise<SubmitOutcome> {
    let job: JobRecord | null = null;
    try {
      const parsed = GenerationRequestSchema.parse(request);
      const recipe = this.recipeOf(parsed);
      const graph = await this.loadGraph(recipe);
      planWorkflow(recipe, parsed.input, graph, 0);
      for (const path of parsed.input.images) {
        await access(path).catch(() => {
          throw invalid("A reference image file is missing.");
        });
      }
      const claim = await claimRequest(this.repository, parsed, "submitting", this.now());
      if (!claim.created) return { kind: "existing", job: claim.job };
      job = claim.job;
      return await this.dispatch(job, graph);
    } catch (cause) {
      const error = toJobError(cause);
      if (job && error.code !== "conflict") {
        const current = await this.repository.get(job.id);
        if (current && current.status === "submitting") return { kind: "failed", job: await failJob(this.repository, current, error, this.now()), error };
      }
      return { kind: "failed", job, error };
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
    if (job.providerRef) return this.observe(job);
    return this.recover(job);
  }

  async retrieve(jobId: string, destination: RetrieveDestination): Promise<RetrieveOutcome> {
    const job = await loadJob(this.repository, jobId);
    if (job.status === "completed") return { kind: "completed", job, metrics: null };
    if (job.status === "failed") return { kind: "failed", job, error: job.error ?? jobError("provider", "This job failed.") };
    if (job.status !== "retrieving" || !job.providerRef) return { kind: "not_ready", job };
    const recipe = this.recipeOf(job.request);
    let handle: CloudJobHandle;
    try {
      handle = await this.client.jobs.get(job.providerRef);
    } catch (cause) {
      if (cause instanceof NotFound) return this.retrieveFailed(job, jobError("provider", "Comfy no longer has this job's outputs; they expire after a few hours.", false, "expired"));
      return this.retrieveFailed(job, jobError("provider", "Comfy could not be reached to collect the outputs. Retrieval will retry.", true));
    }
    const outputs = handle.getOutputs(recipe.sidecar.outputNode);
    if (!outputs.length) {
      return this.retrieveFailed(job, jobError("provider", `The workflow finished without an output on node ${recipe.sidecar.outputNode}.`));
    }
    try {
      const plan = planWorkflow(recipe, job.request.input, await this.loadGraph(recipe), seedFromId(job.id));
      const extension = plan.expectation.media === "video" ? "mp4" : "png";
      const saved: JobOutput[] = [];
      for (const [index, output] of outputs.entries()) {
        const { absolute, relative } = outputLocation(destination, `${job.id}-${index}.${extension}`);
        const temporary = await tempBeside(absolute);
        try {
          await output.toFile(temporary);
        } catch {
          await rm(temporary, { force: true });
          throw new ExecutorFailure(jobError("provider", "An output download from Comfy did not finish. Retrieval will retry.", true));
        }
        saved.push(await commitOutput(temporary, absolute, relative, plan.expectation));
      }
      const completed = await transition(this.repository, job, { status: "completed", outputs: saved, notice: null, error: null }, this.now());
      this.pollCounts.delete(job.id);
      return { kind: "completed", job: completed, metrics: readMetrics(handle.metrics) };
    } catch (cause) {
      return this.retrieveFailed(job, toJobError(cause));
    }
  }

  async cancel(jobId: string): Promise<CancelOutcome> {
    try {
      const job = await loadJob(this.repository, jobId);
      if (job.status === "completed" || job.status === "failed" || job.status === "retrieving") return { kind: "too_late", job };
      if (!job.providerRef) return { kind: "failed", error: jobError("conflict", "This submission is not confirmed yet, so it cannot be canceled. Check again shortly.", true) };
      const handle = await this.client.jobs.get(job.providerRef);
      await handle.cancel();
      const error = jobError("invalid", "Canceled before it finished.", false, "canceled");
      return { kind: "canceled", job: await failJob(this.repository, job, error, this.now()) };
    } catch (cause) {
      return { kind: "failed", error: toJobError(cause, "The cancel request did not reach Comfy.") };
    }
  }

  private recipeOf(request: Pick<GenerationRequest, "recipe">): WorkflowRecipe {
    if (request.recipe.kind !== "workflow") throw invalid("The workflow executor runs workflow recipes only.");
    return request.recipe;
  }

  private async loadGraph(recipe: WorkflowRecipe): Promise<WorkflowGraph> {
    let raw: string;
    try {
      raw = await readFile(join(this.workflowsDir, recipe.file), "utf8");
    } catch {
      throw invalid(`The workflow file ${recipe.file} is missing.`);
    }
    const graph = WorkflowGraphSchema.parse(JSON.parse(raw));
    const problems = sidecarProblems(recipe.sidecar, graph);
    if (problems.length) throw invalid(`The ${recipe.file} sidecar does not match the workflow. ${problems.join(" ")}`);
    return graph;
  }

  /** Builds the graph, uploads images lazily through the SDK, and submits with the job id as key. */
  private async dispatch(job: JobRecord, graph?: WorkflowGraph): Promise<SubmitOutcome> {
    const recipe = this.recipeOf(job.request);
    const workflowGraph = graph ?? (await this.loadGraph(recipe));
    const plan = planWorkflow(recipe, job.request.input, workflowGraph, seedFromId(job.id));
    const scratch = recipe.fitImages && plan.images.length ? await mkdtemp(join(tmpdir(), "acl-fit-")) : undefined;
    try {
      const workflow = this.client.workflows.fromJson(structuredClone(workflowGraph));
      const values: Record<string, SlotValue> = { ...plan.values };
      for (const image of plan.images) {
        let path = image.path;
        if (scratch && plan.width && plan.height) {
          path = join(scratch, `${image.slot}.png`);
          await fitImage(image.path, plan.width, plan.height, path).catch(() => {
            throw invalid("A reference image could not be read as an image.");
          });
        }
        values[image.slot] = this.client.assets.fromFile(path) as object;
      }
      applySlots(workflow, recipe.sidecar, values);
      let handle: CloudJobHandle;
      try {
        handle = await this.client.submit(workflow, { idempotencyKey: job.id });
      } catch (cause) {
        return await this.submitFailed(job, cause);
      }
      let saved: JobRecord;
      try {
        saved = await this.saveObservation(job, handle);
      } catch {
        // Comfy accepted the job but it could not be recorded; leave it for poll to resolve with the same key.
        return { kind: "uncertain", job: (await this.repository.get(job.id).catch(() => undefined)) ?? job };
      }
      return saved.status === "failed" ? { kind: "failed", job: saved, error: saved.error! } : { kind: "accepted", job: saved };
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  private async submitFailed(job: JobRecord, cause: unknown): Promise<SubmitOutcome> {
    if (cause instanceof IdempotencyKeyReuse) {
      const fresh = await loadJob(this.repository, job.id);
      if (fresh.providerRef) {
        const handle = await this.client.jobs.get(fresh.providerRef);
        const saved = await this.saveObservation(fresh, handle);
        return saved.status === "failed" ? { kind: "failed", job: saved, error: saved.error! } : { kind: "accepted", job: saved };
      }
      const notice = "Comfy already received this submission, but its job id was not saved. It will not be sent again; check your Comfy job history.";
      return { kind: "uncertain", job: await this.save(fresh, { status: "uncertain", notice }) };
    }
    const classified = classifySubmitError(cause);
    const current = await loadJob(this.repository, job.id);
    if (classified.outcome === "failed") return { kind: "failed", job: await failJob(this.repository, current, classified.error, this.now()), error: classified.error };
    return { kind: "uncertain", job: await this.save(current, { status: "uncertain", notice: classified.notice }) };
  }

  /** Resolves a submission with no saved provider id: resend under the same key, which Comfy never runs twice. */
  private async recover(job: JobRecord): Promise<PollOutcome> {
    if (this.now() - job.createdAt > RECOVERY_WINDOW_MS) {
      const notice = "This submission could not be confirmed within a day and its idempotency key has expired. Check your Comfy job history before generating again.";
      const saved = job.notice === notice && job.status === "uncertain" ? job : await this.save(job, { status: "uncertain", notice });
      return { kind: "uncertain", job: saved, retryAfterMs: 60 * 60_000 };
    }
    const claimed = await this.save(job, { status: "submitting", notice: null });
    const outcome = await this.dispatch(claimed).catch(async (cause: unknown): Promise<SubmitOutcome> => {
      const error = toJobError(cause);
      const current = await loadJob(this.repository, job.id);
      return { kind: "failed", job: await failJob(this.repository, current, error, this.now()), error };
    });
    if (outcome.kind === "failed") return { kind: "failed", job: outcome.job ?? (await loadJob(this.repository, job.id)), error: outcome.error };
    if (outcome.kind === "uncertain") return { kind: "uncertain", job: outcome.job, retryAfterMs: this.nextDelay(job.id) };
    return this.toPoll(outcome.job);
  }

  private async observe(job: JobRecord): Promise<PollOutcome> {
    let handle: CloudJobHandle;
    try {
      handle = await this.client.jobs.get(job.providerRef!);
    } catch (cause) {
      if (cause instanceof NotFound) {
        const error = jobError("provider", "Comfy no longer knows this job; it may have expired.", false, "not_found");
        return { kind: "failed", job: await failJob(this.repository, job, error, this.now()), error };
      }
      return { kind: "pending", job, retryAfterMs: this.nextDelay(job.id), queuePosition: null };
    }
    const saved = await this.saveObservation(job, handle);
    return this.toPoll(saved, handle.queuePosition);
  }

  private toPoll(job: JobRecord, queuePosition: number | null = null): PollOutcome {
    if (job.status === "retrieving") return { kind: "ready", job };
    if (job.status === "failed") return { kind: "failed", job, error: job.error ?? jobError("provider", "This job failed.") };
    if (job.status === "completed") return { kind: "completed", job };
    if (job.status === "uncertain") return { kind: "uncertain", job, retryAfterMs: this.nextDelay(job.id) };
    return { kind: "pending", job, retryAfterMs: this.nextDelay(job.id), queuePosition };
  }

  private nextDelay(jobId: string): number {
    const attempt = this.pollCounts.get(jobId) ?? 0;
    this.pollCounts.set(jobId, attempt + 1);
    return backoffMs(attempt);
  }

  /** Saves the provider id and the observed state together, the moment they are known. */
  private async saveObservation(job: JobRecord, handle: CloudJobHandle): Promise<JobRecord> {
    const status = cloudStatus(handle.status);
    if (status === job.status && handle.id === job.providerRef) return job;
    const patch: JobPatch = { status, providerRef: handle.id, notice: null };
    if (status === "failed") patch.error = cloudJobError(handle.status, handle.error);
    return this.save(job, patch);
  }

  /** Transition with a re-read on a lost race, so a provider id is never dropped. */
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
      return { kind: "retry", job: saved, retryAfterMs: this.nextDelay(job.id), error };
    }
    return { kind: "failed", job: await failJob(this.repository, job, error, this.now()), error };
  }
}

function readMetrics(value: unknown): JobMetrics | null {
  if (!value || typeof value !== "object") return null;
  const metrics: JobMetrics = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" || entry === null) metrics[key] = entry;
  }
  return metrics;
}

