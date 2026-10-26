/**
 * The live Router model list and per-model schemas, cached as JSON under the data directory.
 * Listing and schema reads are free and never generate. Schemas revalidate by ETag, and the listing's
 * per-model `schema_etag` lets an unchanged schema be served from cache with no request at all.
 * @packageDocumentation
 */
import { comfy } from "@comfyorg/sdk";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Capability } from "@/lib/catalog";
import { tagModel, type ModelTags } from "@/server/catalog/tagging";

/** The slice of `comfy.models` the catalog reads. */
export interface CatalogPort {
  list(): AsyncIterable<{ id: string; provider: string; model: string; [field: string]: unknown }>;
  schema(id: string, options?: { etag?: string | null }): Promise<{ unchanged: boolean; document: unknown; etag: string | null }>;
}

export function createCatalogPort(apiKey: string): CatalogPort {
  comfy.config({ credentials: apiKey });
  return comfy.models;
}

const ModelEntrySchema = z.object({
  id: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  provider: z.string(),
  model: z.string(),
  schemaEtag: z.string().nullable(),
  chargesOnPolicyRejection: z.boolean().nullable(),
});
export type RouterModelEntry = z.infer<typeof ModelEntrySchema>;

const ModelsCacheSchema = z.object({ version: z.literal(1), fetchedAt: z.number(), models: z.array(ModelEntrySchema) });
const SchemaEntrySchema = z.object({ etag: z.string().nullable(), fetchedAt: z.number(), document: z.unknown() });
const SchemasCacheSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), SchemaEntrySchema) });

export interface TaggedModel extends RouterModelEntry {
  tags: ModelTags | null;
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface RouterCatalogOptions {
  port: CatalogPort;
  /** The app's data directory; caches live in `<dataDir>/catalog/`. */
  dataDir: string;
  now?: () => number;
  /** How long a listing is fresh before `models()` refetches it. */
  maxAgeMs?: number;
}

export class RouterCatalog {
  private readonly port: CatalogPort;
  private readonly directory: string;
  private readonly now: () => number;
  private readonly maxAgeMs: number;

  constructor(options: RouterCatalogOptions) {
    this.port = options.port;
    this.directory = join(options.dataDir, "catalog");
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? 6 * 60 * 60 * 1000;
  }

  private get modelsPath(): string {
    return join(this.directory, "router-models.json");
  }

  private get schemasPath(): string {
    return join(this.directory, "router-schemas.json");
  }

  /** Every Router model, from cache when fresh, walking all pages otherwise. */
  async models(options: { refresh?: boolean } = {}): Promise<RouterModelEntry[]> {
    const cached = await readJson(this.modelsPath, ModelsCacheSchema);
    if (cached && !options.refresh && this.now() - cached.fetchedAt < this.maxAgeMs) return cached.models;
    const models: RouterModelEntry[] = [];
    try {
      for await (const entry of this.port.list()) {
        const billing = entry.billing && typeof entry.billing === "object" ? (entry.billing as Record<string, unknown>) : {};
        const parsed = ModelEntrySchema.safeParse({
          id: entry.id,
          provider: entry.provider,
          model: entry.model,
          schemaEtag: typeof entry.schema_etag === "string" ? entry.schema_etag : null,
          chargesOnPolicyRejection: billing.charges_on_policy_rejection === "yes" ? true : billing.charges_on_policy_rejection === "no" ? false : null,
        });
        if (parsed.success) models.push(parsed.data);
        if (models.length > 5000) break;
      }
    } catch (cause) {
      if (cached) return cached.models;
      throw cause;
    }
    await mkdir(this.directory, { recursive: true });
    await writeJsonAtomic(this.modelsPath, { version: 1, fetchedAt: this.now(), models });
    return models;
  }

  /** One model's OpenAPI document. Served from cache when its ETag matches the listing, else revalidated. */
  async schema(id: string, options: { refresh?: boolean } = {}): Promise<unknown> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(id)) throw new Error("Unknown Router model id.");
    const cache = (await readJson(this.schemasPath, SchemasCacheSchema)) ?? { version: 1 as const, entries: {} };
    const entry = cache.entries[id];
    if (entry && !options.refresh) {
      const listed = (await readJson(this.modelsPath, ModelsCacheSchema))?.models.find((model) => model.id === id);
      if (listed && listed.schemaEtag !== null && listed.schemaEtag === entry.etag) return entry.document;
    }
    let result: Awaited<ReturnType<CatalogPort["schema"]>>;
    try {
      result = await this.port.schema(id, { etag: entry?.etag ?? null });
    } catch (cause) {
      if (entry) return entry.document;
      throw cause;
    }
    const document = result.unchanged && entry ? entry.document : result.document;
    const meta = document && typeof document === "object" ? (document as Record<string, unknown>) : {};
    if (meta["x-comfy-router-model-id"] !== undefined && meta["x-comfy-router-model-id"] !== id) throw new Error("The schema belongs to another model.");
    const latest = (await readJson(this.schemasPath, SchemasCacheSchema)) ?? cache;
    latest.entries[id] = { etag: result.etag ?? entry?.etag ?? null, fetchedAt: this.now(), document };
    await mkdir(this.directory, { recursive: true });
    await writeJsonAtomic(this.schemasPath, latest);
    return document;
  }

  /** Cached schema only; never makes a request. Used to validate request bodies at submit time. */
  async cachedSchema(id: string): Promise<unknown | undefined> {
    return (await readJson(this.schemasPath, SchemasCacheSchema))?.entries[id]?.document;
  }

  /** Models with tags where a schema is cached (or fetched when `fetchSchemas` is set). */
  async tagged(options: { fetchSchemas?: boolean; ids?: string[] } = {}): Promise<TaggedModel[]> {
    const models = await this.models();
    const wanted = options.ids ? models.filter((model) => options.ids!.includes(model.id)) : models;
    const tagged: TaggedModel[] = [];
    for (const model of wanted) {
      const document = options.fetchSchemas ? await this.schema(model.id).catch(() => undefined) : await this.cachedSchema(model.id);
      tagged.push({ ...model, tags: document ? tagModel(model.id, document) : null });
    }
    return tagged;
  }

  /** Tagged models that satisfy a capability, for the recipe picker. */
  async byCapability(capability: Capability, options: { fetchSchemas?: boolean } = {}): Promise<TaggedModel[]> {
    return (await this.tagged(options)).filter((model) => model.tags?.capabilities.includes(capability));
  }
}
