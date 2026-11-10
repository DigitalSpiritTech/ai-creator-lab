/**
 * The durable record of a chained take: the plan (segments, crossfade, what drives each segment),
 * the recipe snapshot every segment job runs, the job and asset each segment produced, and the
 * stitched result with its seam report. Saved in the `chains` table; every step of the chain reads
 * only this record and the jobs it names, so a restart resumes exactly where the chain stopped.
 *
 * Budget: a chain reserves every segment up front. Segments without a job yet are a hold
 * ({@link chainHoldUsd}) that the spend policy counts as reserved, so other spending cannot strand
 * a half-paid chain; once a segment's job is admitted, the job's own reservation takes over.
 * @packageDocumentation
 */
import { z } from "zod";
import { RecipeSchema } from "@creator-lab/core/catalog";
import { IdSchema, MediaPathSchema, RevisionSchema, Sha256Schema, TimestampSchema } from "@creator-lab/core/domain/common";
import { GenerationTargetSchema, JobErrorSchema, JobInputSchema } from "@creator-lab/core/domain/job";
import { OwnerIdSchema } from "@creator-lab/core/domain/owner";
import { ShotSpecSchema } from "@creator-lab/core/domain/shot-spec";

const FileRefSchema = z.object({ relativePath: MediaPathSchema, sha256: Sha256Schema }).strict();

export const ChainSegmentSchema = z
  .object({
    index: z.number().int().min(1).max(13),
    /** The segment job's request id; derived from the chain's, so admission is idempotent. */
    requestId: IdSchema,
    /** The request id of the one automatic retry after a black or empty output. */
    retryRequestId: IdSchema,
    /** Where the segment starts in the take, and how long it runs. */
    startSeconds: z.number().nonnegative(),
    durationSeconds: z.number().positive().max(60),
    /** The words it speaks (empty on b-roll), and its rendered prompt. */
    line: z.string().max(300),
    prompt: z.string().min(1).max(10_000),
    /** What admission reserves, from the estimate taken when the chain was admitted. */
    reserveUsd: z.number().nonnegative(),
    /** The frame it starts from (segment 2 on): the previous segment's handover frame. */
    startFrame: FileRefSchema.nullable().default(null),
    /** Its slice of the voice take (audio-driven chains). */
    audio: FileRefSchema.nullable().default(null),
    jobId: IdSchema.nullable().default(null),
    assetId: IdSchema.nullable().default(null),
  })
  .strict();
export type ChainSegment = z.infer<typeof ChainSegmentSchema>;

export const SeamReportSchema = z
  .object({
    seconds: z.number().nonnegative(),
    issues: z.array(z.enum(["black", "freeze", "jump", "audio_gap", "audio_click"])).max(5),
    videoDifference: z.number(),
    videoBaseline: z.number(),
    quietestDb: z.number().nullable(),
    clickRatio: z.number().nullable(),
  })
  .strict();

/**
 * `running` holds the budget for segments not yet admitted; `paused` (a segment could not be
 * admitted under the budget) holds nothing and resumes when the proposal is submitted again;
 * `stitching` has every segment and joins them; `completed` and `failed` are final.
 */
export const ChainStatusSchema = z.enum(["running", "paused", "stitching", "completed", "failed"]);
export type ChainStatus = z.infer<typeof ChainStatusSchema>;

export const ChainSchema = z
  .object({
    id: IdSchema,
    /** The proposal candidate's request id: one chain per candidate. */
    requestId: IdSchema,
    projectId: IdSchema,
    ownerId: OwnerIdSchema,
    recipe: RecipeSchema,
    drive: z.enum(["first_frame", "audio"]),
    /** The take as planned, and the crossfade at every seam. */
    totalSeconds: z.number().positive().max(60),
    overlapSeconds: z.number().nonnegative().max(1),
    aspectRatio: z.string().max(8).optional(),
    seed: z.number().int().min(0).max(4_294_967_295).optional(),
    slots: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    /** Pinned inputs: the starting still first, then an identity reference when the recipe takes one. */
    inputs: z.array(JobInputSchema).min(1).max(4),
    /** The same inputs' paths relative to the data directory, in order; later segments swap the first for their start frame. */
    images: z.array(z.string().min(1).max(4096)).min(1).max(4),
    /** The continuous voice take that becomes the take's audio, when the beat has one. */
    spine: z
      .object({ assetId: IdSchema, sha256: Sha256Schema, relativePath: MediaPathSchema, durationSeconds: z.number().positive() })
      .strict()
      .nullable(),
    target: GenerationTargetSchema,
    /** The beat's clip spec the segments were split from. */
    spec: ShotSpecSchema,
    segments: z.array(ChainSegmentSchema).min(2).max(13),
    status: ChainStatusSchema,
    /** Why a chain is paused, or what the seam check found, in words a person can act on. */
    notice: z.string().max(600).nullable(),
    error: JobErrorSchema.nullable(),
    outputAssetId: IdSchema.nullable(),
    seams: z.array(SeamReportSchema).max(12).default([]),
    revision: RevisionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .refine((chain) => chain.segments.every((segment, position) => segment.index === position + 1), "Segments are numbered from 1 in order.");
export type Chain = z.infer<typeof ChainSchema>;
export type ChainInput = z.input<typeof ChainSchema>;

export function isChainActive(chain: Pick<Chain, "status">): boolean {
  return chain.status === "running" || chain.status === "stitching";
}

export function isChainFinal(chain: Pick<Chain, "status">): boolean {
  return chain.status === "completed" || chain.status === "failed";
}

/** The whole chain's reservation: every segment's estimate. */
export function chainReserveUsd(chain: Pick<Chain, "segments">): number {
  return Math.round(chain.segments.reduce((sum, segment) => sum + segment.reserveUsd, 0) * 1e6) / 1e6;
}

/**
 * What an active chain still holds against the budget: the reservations of segments whose job is
 * not admitted yet (`admitted` says whether a request id already has a job). Paused and final
 * chains hold nothing.
 */
export function chainHoldUsd(chain: Pick<Chain, "status" | "segments">, admitted: (requestId: string) => boolean): number {
  if (chain.status !== "running") return 0;
  return chain.segments.reduce((sum, segment) => (admitted(segment.requestId) ? sum : sum + segment.reserveUsd), 0);
}

/** The next record after an update, with the revision bumped and the result checked. */
export function updateChain(chain: Chain, patch: Partial<Omit<Chain, "id" | "requestId" | "projectId" | "ownerId" | "revision" | "createdAt">>, now: number): Chain {
  return ChainSchema.parse({ ...chain, ...patch, revision: chain.revision + 1, updatedAt: now });
}

/** A segment patched in place. */
export function withSegment(chain: Chain, index: number, patch: Partial<ChainSegment>): Chain["segments"] {
  return chain.segments.map((segment) => (segment.index === index ? ChainSegmentSchema.parse({ ...segment, ...patch }) : segment));
}
