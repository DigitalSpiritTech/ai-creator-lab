/**
 * Builds a Router model's native request body from a recipe's semantic field map, so no model needs a
 * hand-written body type. The same inputs always produce the same body, which is what lets a lost
 * response be collected again under the same idempotency key.
 * @packageDocumentation
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { FieldTargets, ImageField, RouterRecipe } from "@/lib/catalog";
import { ExecutorFailure, jobError } from "@/server/executors/jobs";
import type { GenerationInput } from "@/server/executors/types";

export interface PreparedImage {
  /** Raw base64 of the file. */
  base64: string;
  mime: string;
  /** Short-lived fetchable URL, for models that take images by URL. */
  url?: string;
}

function invalid(message: string): ExecutorFailure {
  return new ExecutorFailure(jobError("invalid", message));
}

function segments(path: string): (string | number)[] {
  return path.split(".").map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}

/** Reads a value at a dotted path, or undefined. */
export function getPath(body: unknown, path: string): unknown {
  let node: unknown = body;
  for (const segment of segments(path)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

/** Writes a value at a dotted path, creating objects and arrays along the way. */
export function setPath(body: Record<string, unknown>, path: string, value: unknown): void {
  const parts = segments(path);
  let node: Record<string | number, unknown> = body;
  for (const [index, segment] of parts.slice(0, -1).entries()) {
    const next = parts[index + 1];
    if (node[segment] === undefined || node[segment] === null || typeof node[segment] !== "object") {
      node[segment] = typeof next === "number" ? [] : {};
    }
    node = node[segment] as Record<string | number, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

function assign(body: Record<string, unknown>, targets: FieldTargets | undefined, value: string | number | undefined, field: string): void {
  if (targets === undefined || value === undefined) return;
  for (const target of Array.isArray(targets) ? targets : [targets]) {
    if (target.values) {
      const mapped = target.values[String(value)];
      if (mapped === undefined) throw invalid(`This model does not accept ${field} ${value}.`);
      setPath(body, target.path, mapped);
    } else {
      setPath(body, target.path, value);
    }
  }
}

/** Replaces "{data}" (whole string), "{mime}", and "{role}" placeholders in an image item template. */
function fill(template: unknown, data: string, mime: string, role: string): unknown {
  if (typeof template === "string") return template === "{data}" ? data : template.replaceAll("{mime}", mime).replaceAll("{role}", role);
  if (Array.isArray(template)) return template.map((item) => fill(item, data, mime, role));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, data, mime, role)]));
  }
  return template;
}

function encode(image: PreparedImage, encoding: ImageField["encoding"]): string {
  if (encoding === "base64") return image.base64;
  if (encoding === "data_url") return `data:${image.mime};base64,${image.base64}`;
  if (!image.url) throw invalid("This model takes images by URL; upload the reference first.");
  return image.url;
}

function placeImages(body: Record<string, unknown>, field: ImageField, images: PreparedImage[]): void {
  if (images.length < field.min) throw invalid(`This model needs at least ${field.min} reference image${field.min === 1 ? "" : "s"}.`);
  if (images.length > field.max) throw invalid(`This model takes at most ${field.max} reference image${field.max === 1 ? "" : "s"}.`);
  if (!images.length) return;
  const roles = field.roles ?? [];
  const items = images.map((image, index) => fill(field.item, encode(image, field.encoding), image.mime, roles[Math.min(index, roles.length - 1)] ?? ""));
  if (field.mode === "set") {
    setPath(body, field.path, items[0]);
    return;
  }
  if (field.mode === "indexed") {
    const paths = field.paths ?? [];
    if (items.length > paths.length) throw invalid(`This model takes at most ${paths.length} reference image${paths.length === 1 ? "" : "s"}.`);
    items.forEach((item, index) => setPath(body, paths[index], item));
    return;
  }
  const existing = getPath(body, field.path);
  setPath(body, field.path, [...(Array.isArray(existing) ? existing : []), ...items]);
}

/** "whole seconds from 3 to 15" for a consecutive list, otherwise the list itself. */
export function describeDurations(durations: number[]): string {
  const sorted = [...durations].sort((a, b) => a - b);
  const consecutive = sorted.length > 2 && sorted.every((value, index) => Number.isInteger(value) && (index === 0 || value === sorted[index - 1] + 1));
  if (consecutive) return `whole seconds from ${sorted[0]} to ${sorted[sorted.length - 1]}`;
  return `${sorted.join(", ")} seconds`;
}

/** Builds the native body for one request. Images must already be read and encoded. */
export function buildRouterBody(recipe: RouterRecipe, input: GenerationInput, images: PreparedImage[]): Record<string, unknown> {
  const map = recipe.fieldMap;
  const body = structuredClone(map.template) as Record<string, unknown>;
  const aspectRatio = input.aspectRatio ?? recipe.defaults.aspectRatio;
  if (aspectRatio && recipe.limits.aspectRatios && !recipe.limits.aspectRatios.includes(aspectRatio)) {
    throw invalid(`${recipe.title} does not offer ${aspectRatio}.`);
  }
  const duration = input.durationSeconds ?? recipe.defaults.durationSeconds;
  if (duration !== undefined && recipe.limits.durations && !recipe.limits.durations.includes(duration)) {
    throw invalid(`${recipe.title} makes clips of ${describeDurations(recipe.limits.durations)}; this beat is ${duration} s.`);
  }
  if (!map.images && images.length) throw invalid(`${recipe.title} does not take reference images.`);
  assign(body, map.prompt, input.prompt, "prompt");
  if (map.images) placeImages(body, map.images, images);
  assign(body, map.aspectRatio, aspectRatio, "aspect ratio");
  assign(body, map.sizeTier, input.sizeTier ?? recipe.defaults.sizeTier, "size");
  assign(body, map.duration, duration, "duration");
  assign(body, map.seed, input.seed, "seed");
  return body;
}

function sniffMime(bytes: Uint8Array, path: string): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP") return "image/webp";
  const extension = extname(path).toLowerCase();
  throw invalid(`Reference images must be PNG, JPEG, or WebP${extension ? `, not ${extension}` : ""}.`);
}

/** Reads reference files and, when the recipe takes URLs, uploads them through `assetUrl`. */
export async function prepareImages(paths: string[], recipe: RouterRecipe, assetUrl?: (path: string) => Promise<string>): Promise<PreparedImage[]> {
  const prepared: PreparedImage[] = [];
  for (const path of paths) {
    const bytes = await readFile(path).catch(() => {
      throw invalid("A reference image file is missing.");
    });
    const image: PreparedImage = { base64: bytes.toString("base64"), mime: sniffMime(bytes, path) };
    if (recipe.fieldMap.images?.encoding === "url") {
      if (!assetUrl) throw invalid("This model takes images by URL, and no upload is configured.");
      image.url = await assetUrl(path);
    }
    prepared.push(image);
  }
  return prepared;
}
