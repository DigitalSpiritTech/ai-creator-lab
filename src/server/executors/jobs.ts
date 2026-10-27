/**
 * Job helpers shared by every executor: guarded transitions through the store port, safe failure
 * values, path resolution against the media root, and poll pacing.
 * @packageDocumentation
 */
import { isAbsolute, resolve } from "node:path";
import { toFailure } from "@/lib/domain/failure";
import {
  JobErrorSchema,
  advanceJob,
  type GenerationInput,
  type Job,
  type JobError,
  type JobPatch,
  type JobStorePort,
  type JobUpdate,
} from "@/lib/domain/job";

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
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const failure = toFailure(error);
    if (failure.code !== "storage") return jobError(failure.code, failure.message);
  }
  return jobError("provider", fallback, true);
}

/** Loads a job or fails with not_found. */
export function loadJob(port: JobStorePort, id: string): Job {
  const job = port.get(id);
  if (!job) throw new ExecutorFailure(jobError("not_found", "This generation job does not exist."));
  return job;
}

/** Applies a guarded transition with optimistic concurrency; a lost race is a retryable conflict. */
export function transition(port: JobStorePort, job: Job, update: JobUpdate, now: number): Job {
  let next: Job;
  try {
    next = advanceJob(job, update, now);
  } catch (cause) {
    throw new ExecutorFailure(jobError("conflict", toFailure(cause).message));
  }
  if (!port.transition(job, next)) throw new ExecutorFailure(jobError("conflict", "Another worker updated this job first.", true));
  return next;
}

/** Marks a job failed with a typed error. */
export function failJob(port: JobStorePort, job: Job, error: JobError, now: number, notice: string | null = null): Job {
  return transition(port, job, { status: "failed", error, notice }, now);
}

/**
 * Applies `patch` (keeping or changing the status), re-reading once or twice on a lost race so a
 * provider reference is never dropped. A job that finished meanwhile is returned as it is.
 */
export function save(port: JobStorePort, job: Job, update: JobUpdate, now: number): Job {
  let current = job;
  for (let attempt = 0; ; attempt++) {
    try {
      return transition(port, current, update, now);
    } catch (cause) {
      if (!(cause instanceof ExecutorFailure) || cause.failure.code !== "conflict" || attempt >= 2) throw cause;
      current = loadJob(port, job.id);
      if (current.status === "completed" || current.status === "failed") return current;
    }
  }
}

/** Keeps the current status and changes only the given fields. */
export function patchJob(port: JobStorePort, job: Job, patch: JobPatch, now: number): Job {
  if (job.status === "completed" || job.status === "failed") return job;
  return save(port, job, { ...patch, status: job.status }, now);
}

/**
 * Moves an admitted (`queued`) job to `submitting` and returns it. A `submitting` job is returned
 * only to the caller holding its latest revision (the one that claimed it); anyone else gets
 * undefined, meaning the job is already being sent.
 */
export function claimForSubmit(port: JobStorePort, job: Job, now: number): Job | undefined {
  const current = loadJob(port, job.id);
  if (current.status === "submitting") return current.revision === job.revision ? current : undefined;
  if (current.status !== "queued" || current.providerRef !== null) return undefined;
  return transition(port, current, { status: "submitting" }, now);
}

/** Resolves request image paths against the data directory; absolute paths pass through. */
export function absoluteInput(input: GenerationInput, mediaRoot: string): GenerationInput {
  return { ...input, images: input.images.map((path) => (isAbsolute(path) ? path : resolve(mediaRoot, path))) };
}

/** Poll pacing: 2 s doubling-ish to a 15 s ceiling. */
export function backoffMs(attempt: number): number {
  return Math.min(15_000, Math.round(2000 * 1.6 ** Math.max(0, attempt)));
}
