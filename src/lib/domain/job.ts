/**
 * Generation jobs shared with the executors, plus the generation target and the proposal the
 * tools return before anything spends credits.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema } from "@/lib/domain/capability";
import { IdSchema, RecipeIdSchema, RevisionSchema, Sha256Schema, TimestampSchema, text } from "@/lib/domain/common";
import { SlotKindSchema } from "@/lib/domain/content";
import { FailureCodeSchema, fail } from "@/lib/domain/failure";

export const ExecutorKindSchema = z.enum(["router", "workflow", "mock"]);
export type ExecutorKind = z.infer<typeof ExecutorKindSchema>;

/** Where a job's outputs land once committed. */
export const GenerationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("character_reference"), characterId: IdSchema, slot: z.enum(["face", "body"]) }).strict(),
  z.object({ kind: z.literal("reference_sheet"), characterId: IdSchema }).strict(),
  z.object({ kind: z.literal("shot"), contentId: IdSchema, beatIndex: z.number().int().positive(), slot: SlotKindSchema }).strict(),
  z.object({ kind: z.literal("loose") }).strict(),
]);
export type GenerationTarget = z.infer<typeof GenerationTargetSchema>;

/** One input image, pinned by hash so a retry sends exactly the same pixels. */
export const JobInputSchema = z
  .object({
    role: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    assetId: IdSchema,
    sha256: Sha256Schema,
  })
  .strict();
export type JobInput = z.infer<typeof JobInputSchema>;

/** The immutable request snapshot: what was asked, with which inputs and parameters. */
export const JobRequestSchema = z
  .object({
    prompt: z.string().max(8000),
    inputs: z.array(JobInputSchema).max(16),
    params: z.record(z.string(), z.json()).default({}),
    count: z.number().int().min(1).max(8).default(1),
    target: GenerationTargetSchema,
  })
  .strict();
export type JobRequest = z.infer<typeof JobRequestSchema>;

export const JobErrorSchema = z
  .object({
    code: FailureCodeSchema,
    message: text(1000),
    retryable: z.boolean(),
  })
  .strict();
export type JobError = z.infer<typeof JobErrorSchema>;

export const JobCostSchema = z
  .object({
    estimatedUsd: z.number().nonnegative().nullable(),
    credits: z.number().nonnegative().nullable(),
  })
  .strict();
export type JobCost = z.infer<typeof JobCostSchema>;

const jobBase = {
  id: IdSchema,
  requestId: IdSchema,
  projectId: IdSchema,
  recipeId: RecipeIdSchema,
  capability: CapabilitySchema,
  executor: ExecutorKindSchema,
  /** The provider's id for this run (Router request id, Cloud prompt id); null until known. */
  providerRef: z.string().min(1).max(200).nullable(),
  request: JobRequestSchema,
  cost: JobCostSchema,
  progress: z.number().min(0).max(1).nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

export const JobSchema = z.discriminatedUnion("status", [
  z.object({ ...jobBase, status: z.literal("queued") }).strict(),
  z.object({ ...jobBase, status: z.literal("submitting") }).strict(),
  /** Submission may or may not have reached the provider; recover by asking it, never by resubmitting blindly. */
  z.object({ ...jobBase, status: z.literal("uncertain") }).strict(),
  z.object({ ...jobBase, status: z.literal("running") }).strict(),
  z.object({ ...jobBase, status: z.literal("retrieving") }).strict(),
  z
    .object({ ...jobBase, status: z.literal("completed"), outputs: z.array(IdSchema).min(1).max(8), completedAt: TimestampSchema })
    .strict(),
  z.object({ ...jobBase, status: z.literal("failed"), error: JobErrorSchema, failedAt: TimestampSchema }).strict(),
]);
export type Job = z.infer<typeof JobSchema>;
export type JobStatus = Job["status"];

export const TERMINAL_JOB_STATUSES = ["completed", "failed"] as const satisfies readonly JobStatus[];

export function isTerminal(job: Job): boolean {
  return job.status === "completed" || job.status === "failed";
}

/** Allowed status moves. Terminal states never change. */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["submitting", "failed"],
  submitting: ["running", "retrieving", "uncertain", "failed"],
  uncertain: ["submitting", "running", "retrieving", "failed"],
  running: ["running", "retrieving", "uncertain", "failed"],
  retrieving: ["completed", "failed", "uncertain"],
  completed: [],
  failed: [],
};

export const NewJobSchema = z
  .object({
    id: IdSchema,
    requestId: IdSchema,
    projectId: IdSchema,
    recipeId: RecipeIdSchema,
    capability: CapabilitySchema,
    executor: ExecutorKindSchema,
    request: JobRequestSchema,
    estimatedUsd: z.number().nonnegative().nullable().default(null),
  })
  .strict();
export type NewJob = z.input<typeof NewJobSchema>;

export function createJob(input: NewJob, now: number): Job {
  const data = NewJobSchema.parse(input);
  return JobSchema.parse({
    id: data.id,
    requestId: data.requestId,
    projectId: data.projectId,
    recipeId: data.recipeId,
    capability: data.capability,
    executor: data.executor,
    providerRef: null,
    request: data.request,
    cost: { estimatedUsd: data.estimatedUsd, credits: null },
    progress: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    status: "queued",
  });
}

type ProgressStatus = Exclude<JobStatus, "completed" | "failed">;

export type JobUpdate =
  | { status: ProgressStatus; providerRef?: string; progress?: number | null; credits?: number | null }
  | { status: "failed"; error: JobError; credits?: number | null }
  | { status: "completed"; outputs: string[]; credits?: number | null };

/**
 * Returns the next job record for a status update, with the revision bumped. Throws a conflict
 * for a move the state machine does not allow. Persist with the store's optimistic transition.
 */
export function advanceJob(job: Job, update: JobUpdate, now: number): Job {
  if (!JOB_TRANSITIONS[job.status].includes(update.status)) {
    fail("conflict", `A job cannot move from ${job.status} to ${update.status}.`);
  }
  const { status, credits } = update;
  // Only non-terminal jobs reach this point, so the record carries no outputs or error to drop.
  const common = {
    ...job,
    revision: job.revision + 1,
    updatedAt: now,
    cost: credits === undefined ? job.cost : { ...job.cost, credits },
  };
  if (update.status === "completed") {
    return JobSchema.parse({ ...common, status, outputs: update.outputs, completedAt: now, progress: 1 });
  }
  if (update.status === "failed") {
    return JobSchema.parse({ ...common, status, error: update.error, failedAt: now });
  }
  return JobSchema.parse({
    ...common,
    status,
    providerRef: update.providerRef ?? job.providerRef,
    progress: update.progress === undefined ? job.progress : update.progress,
  });
}

/**
 * What a spending tool returns instead of submitting: the UI gate (or auto-approve under the
 * allowance) turns an accepted proposal into a job.
 */
export const GenerationProposalSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    capability: CapabilitySchema,
    recipeId: RecipeIdSchema.nullable(),
    prompt: z.string().max(8000),
    inputs: z.array(z.object({ role: JobInputSchema.shape.role, assetId: IdSchema }).strict()).max(16),
    count: z.number().int().min(1).max(8),
    target: GenerationTargetSchema,
    estimate: JobCostSchema,
  })
  .strict();
export type GenerationProposal = z.infer<typeof GenerationProposalSchema>;
