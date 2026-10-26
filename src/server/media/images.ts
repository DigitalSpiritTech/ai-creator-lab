/**
 * Imports uploaded still images as assets: validates, normalizes to sRGB PNG, deduplicates by
 * the original bytes' hash, and stores the result under `references/`.
 * @packageDocumentation
 */
import sharp from "sharp";
import { type Asset, AssetSchema } from "@/lib/domain/asset";
import { fail } from "@/lib/domain/failure";
import { removeMedia, writeAtomic } from "@/server/media/files";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import type { Store } from "@/server/store";

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_PIXELS = 24_000_000;
const MAX_EDGE = 2048;

export interface ImageImport {
  projectId: string | null;
  name: string;
  bytes: Uint8Array;
}

export async function normalizeImage(bytes: Uint8Array): Promise<{ png: Buffer; width: number; height: number }> {
  try {
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS });
    const info = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(info.format ?? "") || (info.pages ?? 1) !== 1) {
      throw new Error("Unsupported image");
    }
    const result = await image
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    return { png: result.data, width: result.info.width, height: result.info.height };
  } catch {
    fail(
      "invalid",
      "Use a valid, non-animated PNG, JPEG, or WebP image up to 24 megapixels. SVG and animated images are not supported.",
    );
  }
}

/** Saves an uploaded image once per project (or once in the Library when `projectId` is null). */
export async function importImage(
  store: Store,
  input: ImageImport,
  context: { now: number; newId: () => string },
): Promise<Asset> {
  if (input.projectId !== null) store.projects.getRequired(input.projectId);
  if (input.bytes.length === 0 || input.bytes.length > MAX_IMAGE_BYTES) fail("invalid", "Choose an image up to 12 MB.");
  const originalSha256 = sha256(input.bytes);
  const existing = store.assets.findUpload(input.projectId, originalSha256);
  if (existing) return existing;
  const { png, width, height } = await normalizeImage(input.bytes);
  const id = context.newId();
  const asset = AssetSchema.parse({
    id,
    projectId: input.projectId,
    kind: "image",
    mime: "image/png",
    relativePath: `references/${id}.png`,
    width,
    height,
    sha256: sha256(png),
    provenance: { source: "upload", name: input.name, originalSha256 },
    state: { state: "active" },
    revision: 0,
    createdAt: context.now,
  });
  await writeAtomic(resolveMediaPath(store.dataDir, asset.relativePath), png);
  try {
    return store.assets.insert(asset);
  } catch (error) {
    await removeMedia(store.dataDir, [asset.relativePath]);
    throw error;
  }
}

/** Center-crops normalized image bytes to an exact size for recipes that need fixed dimensions. */
export async function cropToSize(bytes: Uint8Array, width: number, height: number): Promise<Buffer> {
  return sharp(bytes, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS })
    .resize(width, height, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}
