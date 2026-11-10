/**
 * The backend probe: a free read of a backend's `object_info` (or, for Comfy Router, its model
 * list), compared with what each recipe needs. It never submits anything.
 *
 * The address is typed in by the person running this studio and is usually on their own machine or
 * network, so loopback and LAN addresses are allowed; the request still follows no redirects, stops
 * after a timeout and a size cap, and carries the Comfy API key only to Comfy's own hosts (Cloud and
 * `*.comfy.app` deployments). A self-hosted ComfyUI never receives it.
 * @packageDocumentation
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Backend,
  type BackendProbe,
  COMFY_CLOUD_URL,
  type ObjectInfo,
  ObjectInfoSchema,
  type Recipe,
  type RecipeMissing,
  WorkflowGraphSchema,
  compareRequirements,
  graphRequirements,
  isComfyHost,
  isWorkflowBackend,
} from "@/lib/catalog";
import { fail } from "@/lib/domain/failure";
import { assertCanUseCustomBackends, listBackends } from "@/server/catalog/backends";
import { RouterCatalog, createCatalogPort } from "@/server/catalog/router-catalog";
import type { Store } from "@/server/store";

export const PROBE_TIMEOUT_MS = 30_000;
/** Cloud's full `object_info` is several megabytes; a reply past this is not a ComfyUI. */
export const PROBE_MAX_BYTES = 64 * 1024 * 1024;

export interface ProbeOptions {
  /** The Comfy API key, sent only to Comfy-operated hosts. */
  apiKey?: string;
  /** Folder holding the recipes' `*.api.json` graphs. */
  workflowsDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Router's model ids; defaults to the live list (cached under the data directory). */
  routerModels?: () => Promise<string[]>;
}

class ProbeError extends Error {}

/** Where `object_info` lives on a backend, and the headers to send there. */
export function objectInfoRequests(backend: Pick<Backend, "kind" | "baseUrl">, apiKey: string | undefined): { url: string; headers: Record<string, string> }[] {
  const accept = { Accept: "application/json" };
  if (backend.kind === "cloud") {
    if (!apiKey) throw new ProbeError("Comfy Cloud needs a Comfy API key in Settings before it can be checked.");
    return [{ url: `${COMFY_CLOUD_URL}/api/object_info`, headers: { ...accept, "X-API-Key": apiKey } }];
  }
  const keyed: Record<string, string> = backend.kind === "deployment" && isComfyHost(backend.baseUrl) && apiKey ? { Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey } : {};
  const headers = { ...accept, ...keyed };
  // ComfyUI answers on both; the v2 proxy and deployments mount the API under /api.
  return [
    { url: `${backend.baseUrl}/api/object_info`, headers },
    { url: `${backend.baseUrl}/object_info`, headers },
  ];
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ProbeError("answered with more data than a ComfyUI node list.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ProbeError("answered with more data than a ComfyUI node list.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function unreachable(cause: unknown, timeoutMs: number): ProbeError {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new ProbeError(`did not answer within ${Math.round(timeoutMs / 1000)} s.`);
  return new ProbeError("could not be reached. Check the address and that the server is running.");
}

/** Fetches and validates a backend's `object_info`. Throws a ProbeError with a readable reason. */
export async function fetchObjectInfo(backend: Pick<Backend, "kind" | "baseUrl">, options: Omit<ProbeOptions, "workflowsDir">): Promise<ObjectInfo> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? PROBE_MAX_BYTES;
  let lastStatus: number | undefined;
  for (const request of objectInfoRequests(backend, options.apiKey)) {
    let response: Response;
    try {
      response = await fetchImpl(request.url, { headers: request.headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      throw unreachable(cause, timeoutMs);
    }
    if (response.status === 404 || response.status === 405) {
      lastStatus = response.status;
      await response.body?.cancel();
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ProbeError(`refused the request (HTTP ${response.status}). ${backend.kind === "comfyui" ? "A self-hosted ComfyUI is checked without a key." : "Check the Comfy API key in Settings."}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProbeError(`answered with an error (HTTP ${response.status}).`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await readCapped(response, maxBytes));
    } catch (cause) {
      if (cause instanceof ProbeError) throw cause;
      throw new ProbeError("did not answer with a ComfyUI node list (the reply was not JSON).");
    }
    const parsed = ObjectInfoSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) throw new ProbeError("did not answer with a ComfyUI node list.");
    return parsed.data;
  }
  throw new ProbeError(`does not publish object_info (HTTP ${lastStatus ?? 404}), so its nodes and models cannot be checked before a run.`);
}

/** Compares every workflow recipe with one backend's `object_info`. */
export async function compareWorkflowRecipes(recipes: readonly Recipe[], info: ObjectInfo, workflowsDir: string): Promise<{ checked: string[]; missing: Record<string, RecipeMissing> }> {
  const checked: string[] = [];
  const missing: Record<string, RecipeMissing> = {};
  for (const recipe of recipes) {
    if (recipe.kind !== "workflow") continue;
    let graph;
    try {
      graph = WorkflowGraphSchema.parse(JSON.parse(await readFile(join(workflowsDir, recipe.file), "utf8")));
    } catch {
      continue;
    }
    const result = compareRequirements(graphRequirements(graph), info);
    checked.push(recipe.id);
    if (result.nodes.length || result.models.length) missing[recipe.id] = { nodes: result.nodes.slice(0, 200), models: result.models.slice(0, 200) };
  }
  return { checked, missing };
}

/** Probes one backend against the recipes. Never throws: a failed probe is a result with the reason. */
export async function probeBackend(backend: Backend, recipes: readonly Recipe[], options: ProbeOptions): Promise<BackendProbe> {
  const now = options.now ?? Date.now;
  try {
    if (backend.kind === "router") {
      if (!options.apiKey && !options.routerModels) throw new ProbeError("needs a Comfy API key in Settings before it can be checked.");
      const listed = new Set(await (options.routerModels ?? (() => Promise.reject(new ProbeError("has no model list source."))))());
      const checked: string[] = [];
      const missing: Record<string, RecipeMissing> = {};
      for (const recipe of recipes) {
        if (recipe.kind !== "router") continue;
        checked.push(recipe.id);
        if (!listed.has(recipe.model)) missing[recipe.id] = { nodes: [], models: [recipe.model] };
      }
      return { at: now(), ok: true, nodeClasses: listed.size, checked, missing };
    }
    if (!isWorkflowBackend(backend)) throw new ProbeError("is not a workflow backend.");
    const info = await fetchObjectInfo(backend, options);
    const { checked, missing } = await compareWorkflowRecipes(recipes, info, options.workflowsDir);
    return { at: now(), ok: true, nodeClasses: Object.keys(info).length, checked, missing };
  } catch (cause) {
    const reason = cause instanceof ProbeError ? cause.message : "could not be checked.";
    return { at: now(), ok: false, error: `${backend.label} ${reason}`.slice(0, 400), nodeClasses: 0, checked: [], missing: {} };
  }
}

/**
 * Probes one backend from the list and saves the result on it. Router's model list comes from the
 * cached live catalog (refreshed here) unless `routerModels` is given.
 */
export async function probeAndSave(store: Store, backendId: string, recipes: readonly Recipe[], options: ProbeOptions & { env?: Record<string, string | undefined> }): Promise<Backend> {
  const backend = listBackends(store, { env: options.env }).find((entry) => entry.id === backendId) ?? fail("not_found", "There is no such backend.");
  // Built-ins come from the operator's own environment; a typed-in address is refused on a hosted copy.
  if (!backend.builtIn) assertCanUseCustomBackends(options.env);
  const apiKey = options.apiKey;
  const routerModels =
    options.routerModels ??
    (apiKey
      ? async () => (await new RouterCatalog({ port: createCatalogPort(apiKey), dataDir: store.dataDir }).models({ refresh: true })).map((model) => model.id)
      : undefined);
  const probe = await probeBackend(backend, recipes, { ...options, routerModels });
  return store.backends.update(backendId, (current) => ({ ...current, lastProbe: probe, updatedAt: probe.at })) ?? fail("not_found", "The backend was removed while it was being checked.");
}
