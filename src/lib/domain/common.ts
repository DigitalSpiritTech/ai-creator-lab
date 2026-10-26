/**
 * Primitives shared by every domain contract.
 * @packageDocumentation
 */
import { z } from "zod";

export const IdSchema = z.uuid();
export const TimestampSchema = z.number().int().nonnegative();
export const RevisionSchema = z.number().int().nonnegative();
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** A path relative to the data directory, inside one of the managed media folders. */
export const MediaPathSchema = z
  .string()
  .regex(/^(media|references|exports)\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/, "Use a managed media path.");

export const RecipeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,119}$/, "Use a valid recipe id.");

/** Trimmed, non-empty text with an upper bound. */
export function text(max: number) {
  return z.string().trim().min(1).max(max);
}

/** Trimmed, optional text that defaults to an empty string. */
export function optionalText(max: number) {
  return z.string().trim().max(max).default("");
}

export function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

/** Returns the record with its revision bumped and its update time set. */
export function nextRevision<T extends { revision: number; updatedAt: number }>(record: T, now: number): T {
  return { ...record, revision: record.revision + 1, updatedAt: now };
}
