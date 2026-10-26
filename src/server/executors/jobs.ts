/**
 * Job record helpers shared by every executor: creation, guarded state transitions, request
 * deduplication, and safe failure values.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  JobErrorSchema,
  type GenerationRequest,
  type JobError,
  type JobRecord,
  type JobRepository,
  type JobStatus,
} from "@/server/executors/types";

/** Allowed next states. Self-transitions let an executor refresh a notice or provider reference. */
export const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  submitting: ["submitting", "queued", "running", "retrieving", "uncertain", "failed"],
  uncertain: ["uncertain", "submitting", "queued", "running", "retrieving", "failed"],
  queued: ["queued", "running", "retrieving", "uncertain", "failed"],
  running: ["running", "retrieving", "uncertain", "failed"],
  retrieving: ["retrieving", "completed", "failed"],
  completed: [],
  failed: [],
};

export const TERMINAL: readonly JobStatus[] = ["completed", "failed"];

/** Builds a safe, typed failure. */
export function jobError(code: JobError["code"], message: string, retryable = false, providerCode?: string): JobError {
  return JobErrorSchema.parse({ code, message, retryable, ...(providerCode ? { providerCode } : {}) });
}

/** Thrown inside executors and turned into a failed outcome at the boundary. */
export class ExecutorFailure extends Error {
  readonly failure: JobError;

  constructor(failure: JobError) {
    super(failure.message);
    this.failure = failure;
  }
}

/** Maps an unknown exception to a JobError without leaking paths, URLs, or keys. */
export function toJobError(error: unknown, fallback = "The provider step could not be completed."): JobError {
  if (error instanceof ExecutorFailure) return error.failure;
  const known = JobErrorSchema.safeParse(error);
  if (known.success) return known.data;
  return jobError("provider", fallback, true);
}

/** A new record in its first state. The id doubles as the provider idempotency key. */
export function createJob(request: GenerationRequest, status: JobStatus, now: number, id: string = randomUUID()): JobRecord {
  return {
    id,
    requestId: request.requestId,
    projectId: request.projectId,
    recipeId: request.recipe.id,
    capability: request.recipe.capability,
    status,
    providerRef: null,
    request: { recipe: request.recipe, input: request.input },
    outputs: [],
    error: null,
    notice: null,
    creditsUsed: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Whether an existing job was created from exactly this request. */
export function sameRequest(job: JobRecord, request: GenerationRequest): boolean {
  return (
    job.projectId === request.projectId &&
    isDeepStrictEqual(job.request.recipe, request.recipe) &&
    isDeepStrictEqual(job.request.input, request.input)
  );
}

/**
 * Inserts a job for a request, or returns the existing one for a repeated requestId.
 * A repeated requestId with different contents is a conflict, never a second job.
 */
export async function claimRequest(
  repository: JobRepository,
  request: GenerationRequest,
  status: JobStatus,
  now: number,
): Promise<{ created: boolean; job: JobRecord }> {
  const existing = await repository.getByRequestId(request.requestId);
  if (existing) {
    if (!sameRequest(existing, request)) throw new ExecutorFailure(jobError("conflict", "This request id was already used for a different generation."));
    return { created: false, job: existing };
  }
  const result = await repository.insert(createJob(request, status, now));
  if (!result.inserted && !sameRequest(result.job, request)) {
    throw new ExecutorFailure(jobError("conflict", "This request id was already used for a different generation."));
  }
  return { created: result.inserted, job: result.job };
}

/** Loads a job or fails with not_found. */
export async function loadJob(repository: JobRepository, id: string): Promise<JobRecord> {
  const job = await repository.get(id);
  if (!job) throw new ExecutorFailure(jobError("not_found", "This generation job does not exist."));
  return job;
}

export type JobPatch = Partial<Pick<JobRecord, "status" | "providerRef" | "outputs" | "error" | "notice" | "creditsUsed" | "request">>;

/** Applies a guarded transition with optimistic concurrency; a lost race is a conflict. */
export async function transition(repository: JobRepository, job: JobRecord, patch: JobPatch, now: number): Promise<JobRecord> {
  const status = patch.status ?? job.status;
  if (!TRANSITIONS[job.status].includes(status)) {
    throw new ExecutorFailure(jobError("conflict", `A ${job.status} job cannot become ${status}.`));
  }
  const next: JobRecord = { ...job, ...patch, status, revision: job.revision + 1, updatedAt: now };
  const saved = await repository.update(next, job.revision);
  if (!saved) throw new ExecutorFailure(jobError("conflict", "Another worker updated this job first.", true));
  return saved;
}

/** Marks a job failed with a typed error. */
export async function failJob(repository: JobRepository, job: JobRecord, error: JobError, now: number): Promise<JobRecord> {
  return transition(repository, job, { status: "failed", error, notice: null }, now);
}

/** Poll pacing: 2 s doubling-ish to a 15 s ceiling. */
export function backoffMs(attempt: number): number {
  return Math.min(15_000, Math.round(2000 * 1.6 ** Math.max(0, attempt)));
}
