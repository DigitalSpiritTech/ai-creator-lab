/**
 * Managed media folders under the data directory and safe path resolution.
 * @packageDocumentation
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { MediaPathSchema } from "@/lib/domain/common";

export const MEDIA_DIRECTORIES = ["media", "references", "exports"] as const;
export type MediaDirectory = (typeof MEDIA_DIRECTORIES)[number];

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Resolves a stored relative media path inside the data directory; refuses anything that escapes it. */
export function resolveMediaPath(dataDir: string, relativePath: string): string {
  const checked = MediaPathSchema.parse(relativePath);
  const root = resolve(dataDir);
  const absolute = resolve(root, checked);
  const inside = relative(root, absolute);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("Media path escapes the data directory.");
  return absolute;
}
