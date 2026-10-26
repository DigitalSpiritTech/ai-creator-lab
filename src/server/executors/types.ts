/**
 * Executor contract: one interface for Router, Workflow, and Mock execution, with durable job records
 * persisted through a repository port so a submission survives restarts and is never paid for twice.
 * @packageDocumentation
 */
import { z } from "zod";
import { AspectRatioSchema, CapabilitySchema, RecipeSchema, type RecipeKind } from "@/lib/catalog";
import { ServiceFailureSchema } from "@/lib/domain/failure";

export const JobStatusSchema = z.enum(["queued", "submitting", "uncertain", "running", "retrieving", "completed", "failed"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Semantic inputs a step hands to any recipe; executors map them to native fields or slots. */
export const GenerationInputSchema = z
  .object({
    prompt: z.string().min(1).max(10_000),
    /** Absolute local paths of reference images, in the order the recipe expects. */
    images: z.array(z.string().min(1).max(4096)).max(16).default([]),
    aspectRatio: AspectRatioSchema.optional(),
    width: z.number().int().min(64).max(4096).optional(),
    height: z.number().int().min(64).max(4096).optional(),
    /** Frame count for workflow video recipes; derived from durationSeconds when absent. */
    length: z.number().int().positive().max(2000).optional(),
    durationSeconds: z.number().positive().max(60).optional(),
    sizeTier: z.string().max(16).optional(),
    seed: z.number().int().min(0).max(4_294_967_295).optional(),
    /** Extra named workflow slots such as `imageStrength`. */
    slots: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();
export type GenerationInput = z.infer<typeof GenerationInputSchema>;

export const GenerationRequestSchema = z.object({
  /** Caller-chosen idempotent id: the same requestId always maps to the same job. */
  requestId: z.uuid(),
  projectId: z.string().min(1).max(64),
  recipe: RecipeSchema,
  input: GenerationInputSchema,
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

export const JobErrorSchema = ServiceFailureSchema.extend({
  retryable: z.boolean(),
  /** Provider bucket such as `content_policy_violation`, when one was reported. */
  providerCode: z.string().max(80).optional(),
});
export type JobError = z.infer<typeof JobErrorSchema>;

export const JobOutputSchema = z.object({
  relativePath: z.string().regex(/^[\w-]+(\/[\w-]+)*\/[\w.-]+\.(png|jpg|webp|svg|mp4)$/),
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "video/mp4"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  video: z
    .object({
      frames: z.number().int().positive(),
      fps: z.number().positive(),
      durationSeconds: z.number().positive(),
      hasAudio: z.boolean(),
    })
    .optional(),
});
export type JobOutput = z.infer<typeof JobOutputSchema>;

export const JobRecordSchema = z.object({
  /** Also the idempotency key sent to the provider. */
  id: z.uuid(),
  requestId: z.uuid(),
  projectId: z.string().min(1).max(64),
  recipeId: z.string().min(1).max(80),
  capability: CapabilitySchema,
  status: JobStatusSchema,
  /** Provider job id (Cloud) or request id (Router), saved the moment it is known. */
  providerRef: z.string().max(256).nullable(),
  /** Exact recipe and inputs this job was created with; recovery rebuilds the same request from it. */
  request: GenerationRequestSchema.omit({ requestId: true, projectId: true }),
  outputs: z.array(JobOutputSchema),
  error: JobErrorSchema.nullable(),
  /** Why a job is waiting or uncertain, in words the user can act on. */
  notice: z.string().max(600).nullable(),
  creditsUsed: z.number().nonnegative().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

/** Per-run measurements the provider reported, such as `queue_ms` and `execution_ms`. */
export type JobMetrics = Record<string, number | null>;

export type EstimateOutcome =
  | { kind: "free"; note: string }
  | { kind: "quoted"; usd: number; credits: number; source: "live" | "hint"; note: string }
  | { kind: "unquoted"; ceilingUsd: number | null; note: string }
  | { kind: "rejected"; error: JobError };

export type SubmitOutcome =
  | { kind: "accepted"; job: JobRecord }
  | { kind: "existing"; job: JobRecord }
  | { kind: "uncertain"; job: JobRecord }
  | { kind: "failed"; job: JobRecord | null; error: JobError };

export type PollOutcome =
  | { kind: "pending"; job: JobRecord; retryAfterMs: number; queuePosition: number | null }
  | { kind: "ready"; job: JobRecord }
  | { kind: "completed"; job: JobRecord }
  | { kind: "uncertain"; job: JobRecord; retryAfterMs: number }
  | { kind: "failed"; job: JobRecord; error: JobError };

export type RetrieveOutcome =
  | { kind: "completed"; job: JobRecord; metrics: JobMetrics | null }
  | { kind: "not_ready"; job: JobRecord }
  | { kind: "retry"; job: JobRecord; retryAfterMs: number; error: JobError }
  | { kind: "failed"; job: JobRecord; error: JobError };

export type CancelOutcome =
  | { kind: "canceled"; job: JobRecord }
  | { kind: "too_late"; job: JobRecord }
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
  /** Persists intent, submits once with the job id as idempotency key, and records the provider reference. */
  submit(request: GenerationRequest): Promise<SubmitOutcome>;
  /** One authoritative status check; resolves uncertain submissions before anything is resubmitted. */
  poll(jobId: string): Promise<PollOutcome>;
  /** Copies outputs into managed storage through temp files, verifies them, and completes the job. */
  retrieve(jobId: string, destination: RetrieveDestination): Promise<RetrieveOutcome>;
  cancel?(jobId: string): Promise<CancelOutcome>;
}

/** Persistence port; the in-memory version is for tests, the store implements it on SQLite. */
export interface JobRepository {
  get(id: string): Promise<JobRecord | undefined>;
  getByRequestId(requestId: string): Promise<JobRecord | undefined>;
  /** Inserts unless the requestId exists, in which case the existing job is returned untouched. */
  insert(job: JobRecord): Promise<{ inserted: boolean; job: JobRecord }>;
  /** Replaces the job only when the stored revision equals `expectedRevision`; returns undefined on conflict. */
  update(next: JobRecord, expectedRevision: number): Promise<JobRecord | undefined>;
}
