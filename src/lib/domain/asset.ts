/**
 * Assets: every generated, uploaded, or exported file, with provenance and lifecycle state.
 * @packageDocumentation
 */
import { z } from "zod";
import {
  IdSchema,
  MediaPathSchema,
  RecipeIdSchema,
  RevisionSchema,
  Sha256Schema,
  TimestampSchema,
  text,
} from "@/lib/domain/common";
import { fail } from "@/lib/domain/failure";

export const AssetKindSchema = z.enum(["image", "video", "sheet", "storyboard"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetMimeSchema = z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "video/mp4"]);
export type AssetMime = z.infer<typeof AssetMimeSchema>;

export const AssetInputRefSchema = z.object({ assetId: IdSchema, sha256: Sha256Schema }).strict();
export type AssetInputRef = z.infer<typeof AssetInputRefSchema>;

export const ProvenanceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("generated"),
      recipeId: RecipeIdSchema,
      jobId: IdSchema,
      prompt: z.string().max(8000),
      inputs: z.array(AssetInputRefSchema).max(16),
      mock: z.boolean(),
    })
    .strict(),
  z
    .object({
      source: z.literal("upload"),
      name: text(255),
      originalSha256: Sha256Schema,
    })
    .strict(),
  z
    .object({
      source: z.literal("export"),
      exportId: IdSchema,
      contentId: IdSchema,
    })
    .strict(),
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const AssetStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("active") }).strict(),
  z.object({ state: z.literal("archived"), reason: text(200), archivedAt: TimestampSchema }).strict(),
  z.object({ state: z.literal("deleted"), deletedAt: TimestampSchema }).strict(),
]);
export type AssetState = z.infer<typeof AssetStateSchema>;

export const VideoMetadataSchema = z
  .object({
    durationSeconds: z.number().positive(),
    frameRate: z.number().positive(),
    frameCount: z.number().int().positive(),
    hasAudio: z.boolean(),
    posterPath: MediaPathSchema,
  })
  .strict();
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;

export const AssetSchema = z
  .object({
    id: IdSchema,
    /** Null for Library uploads made outside any project. */
    projectId: IdSchema.nullable(),
    kind: AssetKindSchema,
    mime: AssetMimeSchema,
    relativePath: MediaPathSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: Sha256Schema,
    provenance: ProvenanceSchema,
    state: AssetStateSchema,
    video: VideoMetadataSchema.optional(),
    revision: RevisionSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .refine((asset) => (asset.kind === "video") === (asset.mime === "video/mp4"), "Video assets must be MP4 files.")
  .refine((asset) => asset.kind !== "video" || asset.video !== undefined, "Video assets need playback metadata.");
export type Asset = z.infer<typeof AssetSchema>;

export function isActive(asset: Asset): boolean {
  return asset.state.state === "active";
}

export function archiveAsset(asset: Asset, reason: string, now: number): Asset {
  if (asset.state.state === "deleted") fail("not_found", "This asset was deleted.");
  if (asset.state.state === "archived") return asset;
  return AssetSchema.parse({
    ...asset,
    state: { state: "archived", reason, archivedAt: now },
    revision: asset.revision + 1,
  });
}

export function restoreAsset(asset: Asset): Asset {
  if (asset.state.state === "deleted") fail("not_found", "This asset was deleted and cannot be restored.");
  if (asset.state.state === "active") return asset;
  return AssetSchema.parse({ ...asset, state: { state: "active" }, revision: asset.revision + 1 });
}

export function markAssetDeleted(asset: Asset, now: number): Asset {
  if (asset.state.state === "deleted") return asset;
  return AssetSchema.parse({ ...asset, state: { state: "deleted", deletedAt: now }, revision: asset.revision + 1 });
}

/** File extension used on disk for a MIME type. */
export function extensionFor(mime: AssetMime): string {
  const extensions: Record<AssetMime, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
  };
  return extensions[mime];
}
