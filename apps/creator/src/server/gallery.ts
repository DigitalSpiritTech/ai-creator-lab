/**
 * The gallery on disk: reads `examples/<id>/example.json` at the repository root (or
 * `STUDIO_EXAMPLES_DIR`), checks each with the core schema, serves the output files an example
 * names, and puts an example's Library items into this Library so "Start from this example" can
 * seed a project through the inbound context (`POST /api/projects` with `inbound`).
 *
 * The in-app gallery and the static site builder (`apps/creator/scripts/build-gallery.ts`) read the
 * same folder through `loadGallery`, so a draft shows as "not yet generated" in both.
 * @packageDocumentation
 */
import { createReadStream, existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fail } from "@creator-lab/core/domain/failure";
import { type GalleryExample, GalleryExampleSchema, exampleInbound } from "@creator-lab/core/domain/gallery";
import type { InboundContextInput } from "@creator-lab/core/domain/inbound";
import { type LibraryItem, createCharacter, createProduct, createSet } from "@creator-lab/core/domain/library";
import { bibleContent, productContent } from "@creator-lab/core/domain/document";
import { parseByteRange } from "@/server/media/asset-response";
import { recordDocument } from "@/server/tools/documents";
import { type ToolContext, ownerOf } from "@/server/tools/registry";

/** The examples folder: `STUDIO_EXAMPLES_DIR`, else `examples/` in the working directory (the repository root). */
export function examplesDir(): string {
  return resolve(/* turbopackIgnore: true */ process.env.STUDIO_EXAMPLES_DIR || "examples");
}

export interface GalleryProblem {
  folder: string;
  message: string;
}

export interface Gallery {
  /** Published examples first, then drafts, each by title. */
  examples: GalleryExample[];
  /** Folders that are not valid examples, with the first problem, so a typo never hides silently. */
  problems: GalleryProblem[];
}

/** Reads and checks every example folder. Never throws for a bad example; it becomes a problem. */
export async function loadGallery(dir: string = examplesDir()): Promise<Gallery> {
  const examples: GalleryExample[] = [];
  const problems: GalleryProblem[] = [];
  const entries = existsSync(dir) ? await readdir(dir, { withFileTypes: true }) : [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name, "example.json");
    if (!existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      problems.push({ folder: entry.name, message: "example.json is not valid JSON." });
      continue;
    }
    const parsed = GalleryExampleSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push({ folder: entry.name, message: `${issue?.path.join(".") || "example"}: ${issue?.message ?? "invalid"}` });
      continue;
    }
    const example = parsed.data;
    if (example.id !== entry.name) {
      problems.push({ folder: entry.name, message: `The id ${example.id} must match the folder name.` });
      continue;
    }
    const missing = example.outputs.find((output) => !existsSync(join(dir, entry.name, output.file)));
    if (missing) {
      problems.push({ folder: entry.name, message: `The output ${missing.file} is not in the folder.` });
      continue;
    }
    examples.push(example);
  }
  examples.sort((a, b) => Number(a.status === "draft") - Number(b.status === "draft") || a.title.localeCompare(b.title));
  return { examples, problems };
}

/** One example by id, or a not-found failure. */
export async function loadExample(id: string, dir: string = examplesDir()): Promise<GalleryExample> {
  const { examples } = await loadGallery(dir);
  return examples.find((example) => example.id === id) ?? fail("not_found", "There is no such example in the gallery.");
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4" };

/**
 * Serves one output file an example names, with byte ranges for video. Only files listed in the
 * example's outputs are served, and the path must stay inside the example's folder.
 */
export async function exampleFileResponse(request: Request, example: GalleryExample, name: string, dir: string = examplesDir()): Promise<Response> {
  const output = example.outputs.find((entry) => entry.file === name);
  if (!output) fail("not_found", "This example has no such file.");
  const folder = resolve(dir, example.id);
  const path = resolve(folder, output.file);
  if (!path.startsWith(folder + sep)) fail("not_found", "This example has no such file.");
  const { size } = await stat(path);
  const range = parseByteRange(request.headers.get("range"), size);
  const headers = new Headers({
    "content-type": MIME[output.file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  if (range.kind === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-length", String(range.end - range.start + 1));
  if (range.kind === "partial") headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  const body = request.method === "HEAD" ? null : (Readable.toWeb(createReadStream(path, { start: range.start, end: range.end })) as ReadableStream);
  return new Response(body, { status: range.kind === "partial" ? 206 : 200, headers });
}

/**
 * Makes sure this Library has the example's characters, products, and sets: an unarchived item of
 * the same kind and name owned by the caller is reused unchanged; anything missing is created from
 * the example (with its first document version). Returns the inbound context that starts a project
 * from the example with those items, for `POST /api/projects`.
 */
export function prepareExampleInbound(context: ToolContext, example: GalleryExample): { inbound: InboundContextInput; created: string[]; reused: string[] } {
  const { store } = context;
  const ownerId = ownerOf(context);
  return store.transaction(() => {
    const time = context.now();
    const ids: Record<string, string> = {};
    const created: string[] = [];
    const reused: string[] = [];
    const existing = store.library.list({ includeArchived: false }).filter((item) => item.ownerId === ownerId);
    const find = (kind: LibraryItem["kind"], name: string) =>
      existing.find((item) => item.kind === kind && (item.kind === "character" ? item.bible.name : item.name).trim().toLowerCase() === name.trim().toLowerCase());
    for (const { key, bible } of example.library.characters) {
      const found = find("character", bible.name);
      if (found) {
        reused.push(found.id);
        ids[`character:${key}`] = found.id;
        continue;
      }
      const item = store.library.create(createCharacter(context.newId(), bible, time, ownerId));
      if (item.kind === "character") recordDocument(context, "bible", item.id, bibleContent(item));
      created.push(item.id);
      ids[`character:${key}`] = item.id;
    }
    for (const { key, product } of example.library.products) {
      const found = find("product", product.name);
      if (found) {
        reused.push(found.id);
        ids[`product:${key}`] = found.id;
        continue;
      }
      const item = store.library.create(createProduct(context.newId(), product, time, ownerId));
      if (item.kind === "product") recordDocument(context, "product", item.id, productContent(item));
      created.push(item.id);
      ids[`product:${key}`] = item.id;
    }
    for (const { key, set } of example.library.sets) {
      const found = find("set", set.name);
      if (found) {
        reused.push(found.id);
        ids[`set:${key}`] = found.id;
        continue;
      }
      const item = store.library.create(createSet(context.newId(), set, time, ownerId));
      created.push(item.id);
      ids[`set:${key}`] = item.id;
    }
    return { inbound: exampleInbound(example, ids), created, reused };
  });
}
