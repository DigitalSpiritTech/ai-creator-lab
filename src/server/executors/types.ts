/**
 * Executor contract: one interface for Router, Workflow, and Mock execution. Jobs are the domain
 * `Job` from `@/lib/domain/job`, persisted through `JobStorePort`, so a submission survives restarts
 * and is never paid for twice. Executors never complete a job: `retrieve` records verified files and
 * the run orchestration commits them as assets.
 * @packageDocumentation
 */
import type { Recipe, RecipeKind } from "@/lib/catalog";
import type { GenerationInput, Job, JobError } from "@/lib/domain/job";

export type { GenerationInput, Job, JobError, JobStorePort, RetrievedFile } from "@/lib/domain/job";
export { GenerationInputSchema, JobErrorSchema, JobSchema, RetrievedFileSchema } from "@/lib/domain/job";

/** What an executor needs to price or plan a request before a job exists. */
export interface GenerationRequest {
  requestId: string;
  projectId: string;
  recipe: Recipe;
  input: GenerationInput;
}

/** Per-run measurements the provider reported, such as `queue_ms` and `execution_ms`. */
export type JobMetrics = Record<string, number | null>;

export type EstimateOutcome =
  | { kind: "free"; note: string }
  | { kind: "quoted"; usd: number; credits: number; source: "live" | "hint"; note: string }
  | { kind: "unquoted"; ceilingUsd: number | null; note: string }
  | { kind: "rejected"; error: JobError };

export type SubmitOutcome =
  | { kind: "accepted"; job: Job }
  | { kind: "existing"; job: Job }
  | { kind: "uncertain"; job: Job }
  | { kind: "failed"; job: Job | null; error: JobError };

export type PollOutcome =
  | { kind: "pending"; job: Job; retryAfterMs: number; queuePosition: number | null }
  | { kind: "ready"; job: Job }
  | { kind: "completed"; job: Job }
  | { kind: "uncertain"; job: Job; retryAfterMs: number }
  | { kind: "failed"; job: Job; error: JobError };

/** `completed` means the outputs are verified and recorded in `job.retrieved`; the job itself stays `retrieving` until commit. */
export type RetrieveOutcome =
  | { kind: "completed"; job: Job; metrics: JobMetrics | null }
  | { kind: "not_ready"; job: Job }
  | { kind: "retry"; job: Job; retryAfterMs: number; error: JobError }
  | { kind: "failed"; job: Job; error: JobError };

export type CancelOutcome =
  | { kind: "canceled"; job: Job }
  | { kind: "too_late"; job: Job }
  | { kind: "failed"; error: JobError };

/** Where retrieved files land: `<root>/<folder>/<jobId>-<n>.<ext>`, recorded relative to root. */
export interface RetrieveDestination {
  root: string;
  folder: string;
}

export interface Executor {
  readonly kind: RecipeKind;
  /** Prices a request without generating. */
  estimate(request: GenerationRequest): Promise<EstimateOutcome>;
  /**
   * Sends an admitted job once, with the job id as idempotency key, and records the provider reference.
   * Takes a `queued` or `submitting` job; any other state returns `existing` without sending.
   */
  submit(job: Job): Promise<SubmitOutcome>;
  /** One authoritative status check; resolves uncertain submissions before anything is resubmitted. */
  poll(jobId: string): Promise<PollOutcome>;
  /** Copies outputs into managed storage through temp files, verifies them, and records them on the job. */
  retrieve(jobId: string, destination: RetrieveDestination): Promise<RetrieveOutcome>;
  cancel?(jobId: string): Promise<CancelOutcome>;
}
