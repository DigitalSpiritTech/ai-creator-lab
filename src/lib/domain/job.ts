/**
 * Generation jobs: the one durable record shared by the executors, the run orchestration, and the
 * store. Also the generation target and the proposal that spending tools return before anything runs.
 * @packageDocumentation
 */
import { z } from "zod";
import { AspectRatioSchema, RecipeSchema } from "@/lib/catalog";
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
  /** Product photo candidates; an approved one is added to the product card's images. */
  z.object({ kind: z.literal("product_image"), productId: IdSchema }).strict(),
  z
    .object({ kind: z.literal("shot"), contentId: IdSchema, beatIndex: z.number().int().positive(), slot: SlotKindSchema })
    .strict(),
  z.object({ kind: z.literal("loose") }).strict(),
]);
export type GenerationTarget = z.infer<typeof GenerationTargetSchema>;

/** Semantic inputs any recipe understands; executors map them to native fields or workflow slots. */
export const GenerationInputSchema = z
  .object({
    prompt: z.string().min(1).max(10_000),
    /**
     * Reference images in the order the recipe expects. Paths relative to the data directory
     * (for example `references/<id>.png`) or absolute; executors resolve them against their media root.
     */
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

/** One input image pinned by hash, so provenance and retries refer to exactly the same pixels. */
export const JobInputSchema = z
  .object({
    role: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    assetId: IdSchema,
    sha256: Sha256Schema,
  })
  .strict();
export type JobInput = z.infer<typeof JobInputSchema>;

/** The immutable request snapshot; recovery rebuilds exactly the same provider request from it. */
export const JobRequestSchema = z
  .object({
    recipe: RecipeSchema,
    input: GenerationInputSchema,
    /** Asset pins for `input.images`, in the same order. Empty for images that are not assets (tests, imports). */
    inputs: z.array(JobInputSchema).max(16).default([]),
    target: GenerationTargetSchema.default({ kind: "loose" }),
  })
  .strict();
export type JobRequest = z.infer<typeof JobRequestSchema>;

export const JobErrorSchema = z
  .object({
    code: FailureCodeSchema,
    message: text(1000),
    retryable: z.boolean(),
    /** Provider bucket such as `content_policy_violation`, when one was reported. */
    providerCode: z.string().max(80).optional(),
  })
  .strict();
export type JobError = z.infer<typeof JobErrorSchema>;

/** A verified file the executor copied into managed storage, waiting for the output commit. */
export const RetrievedFileSchema = z
  .object({
    relativePath: z.string().regex(/^[\w-]+(\/[\w-]+)*\/[\w.-]+\.(png|jpg|webp|svg|mp4)$/),
    mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "video/mp4"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: Sha256Schema,
    video: z
      .object({
        frames: z.number().int().positive(),
        fps: z.number().positive(),
        durationSeconds: z.number().positive(),
        hasAudio: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RetrievedFile = z.infer<typeof RetrievedFileSchema>;

const jobBase = {
  /** Also the idempotency key sent to the provider. */
  id: IdSchema,
  requestId: IdSchema,
  projectId: IdSchema,
  recipeId: RecipeIdSchema,
  capability: CapabilitySchema,
  executor: ExecutorKindSchema,
  /** The provider's id for this run (Router request id, Cloud job id); saved the moment it is known. */
  providerRef: z.string().min(1).max(256).nullable(),
  request: JobRequestSchema,
  /** Files retrieved and verified but not yet committed as assets. */
  retrieved: z.array(RetrievedFileSchema).max(16).default([]),
  /** Why a job is waiting or uncertain, in words the user can act on. */
  notice: z.string().max(600).nullable(),
  progress: z.number().min(0).max(1).nullable(),
  /** USD held against the allowance until the job settles. */
  reservedUsd: z.number().nonnegative().nullable(),
  /** Credits the provider reported for this run; null means not reported, never free. */
  creditsUsed: z.number().nonnegative().nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

const matchesRecipe = (job: { recipeId: string; capability: string; executor: string; request: JobRequest }) =>
  job.request.recipe.id === job.recipeId &&
  job.request.recipe.capability === job.capability &&
  job.request.recipe.kind === job.executor;
const RECIPE_MISMATCH = "A job's recipe id, capability, and executor must match its request recipe.";

export const JobSchema = z
  .discriminatedUnion("status", [
    z.object({ ...jobBase, status: z.literal("queued") }).strict(),
    z.object({ ...jobBase, status: z.literal("submitting") }).strict(),
    /** Submission may or may not have reached the provider; recover by asking it under the same key. */
    z.object({ ...jobBase, status: z.literal("uncertain") }).strict(),
    z.object({ ...jobBase, status: z.literal("running") }).strict(),
    z.object({ ...jobBase, status: z.literal("retrieving") }).strict(),
    z
      .object({
        ...jobBase,
        status: z.literal("completed"),
        outputs: z.array(IdSchema).min(1).max(16),
        completedAt: TimestampSchema,
      })
      .strict(),
    z.object({ ...jobBase, status: z.literal("failed"), error: JobErrorSchema, failedAt: TimestampSchema }).strict(),
  ])
  .refine(matchesRecipe, RECIPE_MISMATCH);
export type Job = z.infer<typeof JobSchema>;
export type JobStatus = Job["status"];

export const TERMINAL_JOB_STATUSES = ["completed", "failed"] as const satisfies readonly JobStatus[];

export function isTerminal(job: Pick<Job, "status">): boolean {
  return job.status === "completed" || job.status === "failed";
}

/**
 * Allowed status moves. `queued` is both "admitted, not sent" and "queued at the provider"; a null
 * providerRef tells them apart. Self-moves refresh a notice, provider reference, or retrieved files.
 * Terminal states never change, and `completed` is reached only through the output commit.
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["queued", "submitting", "running", "retrieving", "uncertain", "failed"],
  submitting: ["submitting", "queued", "running", "retrieving", "uncertain", "failed"],
  uncertain: ["uncertain", "submitting", "queued", "running", "retrieving", "failed"],
  running: ["running", "retrieving", "uncertain", "failed"],
  retrieving: ["retrieving", "completed", "failed"],
  completed: [],
  failed: [],
};

export const NewJobSchema = z
  .object({
    id: IdSchema,
    requestId: IdSchema,
    projectId: IdSchema,
    request: JobRequestSchema,
    reservedUsd: z.number().nonnegative().nullable().default(null),
  })
  .strict();
export type NewJob = z.input<typeof NewJobSchema>;

/** A new job in `queued`. Recipe id, capability, and executor come from the request's recipe. */
export function createJob(input: NewJob, now: number): Job {
  const data = NewJobSchema.parse(input);
  return JobSchema.parse({
    id: data.id,
    requestId: data.requestId,
    projectId: data.projectId,
    recipeId: data.request.recipe.id,
    capability: data.request.recipe.capability,
    executor: data.request.recipe.kind,
    providerRef: null,
    request: data.request,
    retrieved: [],
    notice: null,
    progress: null,
    reservedUsd: data.reservedUsd,
    creditsUsed: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    status: "queued",
  });
}

/** Fields any update may set; `undefined` keeps the current value, `null` clears it. */
export interface JobPatch {
  providerRef?: string | null;
  notice?: string | null;
  progress?: number | null;
  creditsUsed?: number | null;
  reservedUsd?: number | null;
  retrieved?: RetrievedFile[];
}

type ProgressStatus = Exclude<JobStatus, "completed" | "failed">;

export type JobUpdate =
  | ({ status: ProgressStatus } & JobPatch)
  | ({ status: "failed"; error: JobError } & JobPatch)
  | ({ status: "completed"; outputs: string[] } & JobPatch);

/** Whether two requests ask for exactly the same generation. */
export function sameRequest(a: JobRequest, b: JobRequest): boolean {
  return JSON.stringify(JobRequestSchema.parse(a)) === JSON.stringify(JobRequestSchema.parse(b));
}

/**
 * Returns the next job record for an update, with the revision bumped. Throws a conflict for a
 * move the state machine does not allow. Persist with the store's optimistic transition.
 */
export function advanceJob(job: Job, update: JobUpdate, now: number): Job {
  if (!JOB_TRANSITIONS[job.status].includes(update.status)) {
    fail("conflict", `A ${job.status} job cannot become ${update.status}.`);
  }
  const keep = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next);
  // Only non-terminal jobs reach this point, so the record carries no outputs or error to drop.
  const common = {
    ...job,
    providerRef: keep(update.providerRef, job.providerRef),
    notice: keep(update.notice, job.notice),
    progress: keep(update.progress, job.progress),
    creditsUsed: keep(update.creditsUsed, job.creditsUsed),
    reservedUsd: keep(update.reservedUsd, job.reservedUsd),
    retrieved: keep(update.retrieved, job.retrieved),
    revision: job.revision + 1,
    updatedAt: now,
  };
  if (update.status === "completed") {
    return JobSchema.parse({ ...common, status: "completed", outputs: update.outputs, completedAt: now, progress: 1 });
  }
  if (update.status === "failed") {
    return JobSchema.parse({ ...common, status: "failed", error: update.error, failedAt: now, notice: keep(update.notice, null) });
  }
  return JobSchema.parse({ ...common, status: update.status });
}

/** The persistence port executors and the run orchestration use. `store.jobs` implements it on SQLite. */
export interface JobStorePort {
  /** Inserts once per requestId; a repeat returns the saved job with `created: false`. */
  add(job: Job): { job: Job; created: boolean };
  get(id: string): Job | undefined;
  getByRequest(requestId: string): Job | undefined;
  /** Every job not completed or failed, oldest first, for restart recovery. */
  listUnfinished(): Job[];
  /** Saves `next` only if the stored job is still `previous` and not terminal. Never completes a job. */
  transition(previous: Job, next: Job): boolean;
}

export const EstimateSummarySchema = z
  .object({
    kind: z.enum(["free", "quoted", "unquoted", "rejected"]),
    usd: z.number().nonnegative().nullable(),
    credits: z.number().nonnegative().nullable(),
    note: z.string().max(600),
  })
  .strict();
export type EstimateSummary = z.infer<typeof EstimateSummarySchema>;

/**
 * What a spending tool returns instead of submitting: the UI gate (or auto-approve under the
 * allowance) passes an accepted proposal to `submit_proposal`, which turns it into jobs.
 */
export const GenerationProposalSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    capability: CapabilitySchema,
    recipeId: RecipeIdSchema,
    recipeTitle: z.string().max(120),
    prompt: z.string().min(1).max(10_000),
    references: z.array(z.object({ role: JobInputSchema.shape.role, assetId: IdSchema }).strict()).max(16),
    aspectRatio: AspectRatioSchema.optional(),
    durationSeconds: z.number().positive().max(60).optional(),
    count: z.number().int().min(1).max(8),
    target: GenerationTargetSchema,
    /** Estimate for one run; the total is this times `count`. */
    estimate: EstimateSummarySchema,
  })
  .strict();
export type GenerationProposal = z.infer<typeof GenerationProposalSchema>;
