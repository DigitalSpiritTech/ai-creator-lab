/**
 * The backend list in Settings: built-in entries kept in step with the environment, backends a
 * person added, the default for workflows, and the record of recipes verified by a real run.
 *
 * Built-ins: Comfy Cloud and Comfy Router are always listed; `COMFY_BASE_URL`, when it names
 * another server, is the `env` entry and stays the default until a person picks another, so an
 * install that set it keeps running workflows where it did.
 * @packageDocumentation
 */
import { randomBytes } from "node:crypto";
import {
  type Backend,
  type BackendKind,
  type BackendRouting,
  BACKEND_KIND_LABELS,
  CLOUD_BACKEND_ID,
  COMFY_CLOUD_URL,
  COMFY_ROUTER_URL,
  ENV_BACKEND_ID,
  type NewBackend,
  ROUTER_BACKEND_ID,
  type UpdateBackend,
  isComfyHost,
  normalizeBackendUrl,
} from "@/lib/catalog/backends";
import { fail } from "@/lib/domain/failure";
import type { Job } from "@/lib/domain/job";
import { hostedMode } from "@/server/demo";
import type { Store } from "@/server/store";

type Env = Record<string, string | undefined>;

interface BuiltIn {
  id: string;
  kind: BackendKind;
  label: string;
  baseUrl: string;
}

/** The kind COMFY_BASE_URL names: a `*.comfy.app` (or other Comfy-run) host is a deployment, anything else self-hosted. */
export function envBackendKind(url: string): BackendKind {
  return isComfyHost(url) ? "deployment" : "comfyui";
}

/** The built-in entries this environment calls for, in list order. */
export function builtInBackends(env: Env = process.env): BuiltIn[] {
  const entries: BuiltIn[] = [];
  const raw = env.COMFY_BASE_URL?.trim();
  const parsed = raw ? normalizeBackendUrl(raw) : undefined;
  if (parsed?.ok && parsed.url !== COMFY_CLOUD_URL) {
    const kind = envBackendKind(parsed.url);
    entries.push({ id: ENV_BACKEND_ID, kind, label: `${BACKEND_KIND_LABELS[kind]} (COMFY_BASE_URL)`, baseUrl: parsed.url });
  }
  entries.push({ id: CLOUD_BACKEND_ID, kind: "cloud", label: "Comfy Cloud", baseUrl: COMFY_CLOUD_URL });
  entries.push({ id: ROUTER_BACKEND_ID, kind: "router", label: "Comfy Router", baseUrl: COMFY_ROUTER_URL });
  return entries;
}

/** Jobs still in flight on a backend; a backend with any cannot be removed. */
function unfinishedOn(store: Store, backendId: string): Job[] {
  return store.jobs.listUnfinished().filter((job) => job.request.recipe.kind === "workflow" && job.request.recipe.backendId === backendId);
}

/**
 * The backend list, with the built-in entries brought in line with the environment first: missing
 * ones are added, the COMFY_BASE_URL entry follows the variable (a new address clears its probe and
 * run history), and it is dropped when the variable is cleared and nothing is running on it.
 */
export function listBackends(store: Store, options: { env?: Env; now?: number } = {}): Backend[] {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const wanted = builtInBackends(env);
  const fresh = (entry: BuiltIn, index: number): Backend => ({ ...entry, default: false, builtIn: true, lastProbe: null, verified: {}, createdAt: index, updatedAt: now });
  let backends: Backend[];
  try {
    backends = store.transaction(() => {
      const stored = new Map(store.backends.list().map((backend) => [backend.id, backend]));
      wanted.forEach((entry, index) => {
        const current = stored.get(entry.id);
        // Built-ins sort before added backends; the index keeps their order stable.
        if (!current) store.backends.put(fresh(entry, index));
        // Jobs bound to the entry keep polling its old address; re-point it once they finish.
        else if ((current.baseUrl !== entry.baseUrl || current.kind !== entry.kind || !current.builtIn) && unfinishedOn(store, entry.id).length === 0) {
          store.backends.put({ ...current, ...entry, builtIn: true, lastProbe: null, verified: {}, updatedAt: now });
        }
      });
      const envEntry = stored.get(ENV_BACKEND_ID);
      if (envEntry && !wanted.some((entry) => entry.id === ENV_BACKEND_ID) && unfinishedOn(store, ENV_BACKEND_ID).length === 0) {
        store.backends.remove(ENV_BACKEND_ID);
      }
      return store.backends.list();
    });
  } catch {
    // A data folder opened read-only (the hosted demo) still lists the built-ins, unsaved.
    const stored = store.backends.list();
    const missing = wanted.map(fresh).filter((entry) => !stored.some((backend) => backend.id === entry.id));
    backends = [...missing, ...stored];
  }
  // A hosted copy offers the built-ins only, even when the data folder came with added backends.
  return hostedMode(env) ? backends.filter((backend) => backend.builtIn) : backends;
}

/** The routing facts for placement: the synced list and whether a Comfy key is set. */
export function backendRouting(store: Store, hasComfyKey: boolean, options: { env?: Env } = {}): BackendRouting {
  return { backends: listBackends(store, options), hasComfyKey };
}

/**
 * A hosted copy (judging or the read-only demo) runs on the operator's server, where a typed-in
 * address would reach the operator's network, so only Comfy Cloud and Router are offered there.
 */
export function assertCanUseCustomBackends(env: Env = process.env): void {
  if (hostedMode(env)) fail("invalid", "Self-hosted ComfyUI and deployment backends can be added only on your own studio, not on a hosted copy.");
}

function newBackendId(): string {
  return `b-${randomBytes(4).toString("hex")}`;
}

/** Adds a backend a person typed in. The caller probes it next. */
export function addBackend(store: Store, input: NewBackend, options: { now?: number; newId?: () => string; env?: Env } = {}): Backend {
  assertCanUseCustomBackends(options.env);
  const now = options.now ?? Date.now();
  const existing = listBackends(store, { env: options.env, now });
  if (input.baseUrl === COMFY_CLOUD_URL || input.baseUrl === COMFY_ROUTER_URL) fail("invalid", "Comfy Cloud and Comfy Router are already in the list.");
  if (existing.some((backend) => backend.baseUrl === input.baseUrl)) fail("conflict", "That address is already in the list.");
  if (existing.length >= 20) fail("invalid", "The list holds up to 20 backends. Remove one first.");
  return store.backends.put({
    id: (options.newId ?? newBackendId)(),
    kind: input.kind,
    label: input.label,
    baseUrl: input.baseUrl,
    default: false,
    builtIn: false,
    lastProbe: null,
    verified: {},
    createdAt: Math.max(now, 1000),
    updatedAt: now,
  });
}

/** Renames a backend or makes it the default for workflows. */
export function updateBackend(store: Store, id: string, patch: UpdateBackend, options: { now?: number; env?: Env } = {}): Backend {
  const now = options.now ?? Date.now();
  const backend = listBackends(store, { env: options.env, now }).find((entry) => entry.id === id) ?? fail("not_found", "There is no such backend.");
  if (patch.default && backend.kind === "router") fail("invalid", "Comfy Router runs hosted models only; pick a workflow backend as the default.");
  let saved = backend;
  if (patch.label !== undefined && patch.label !== backend.label) saved = store.backends.put({ ...backend, label: patch.label, updatedAt: now });
  if (patch.default) saved = store.backends.setDefault(id, now) ?? saved;
  return saved;
}

/** Removes an added backend. Built-ins stay; a backend with jobs in flight stays until they finish. */
export function removeBackend(store: Store, id: string, options: { env?: Env } = {}): void {
  const backend = listBackends(store, options).find((entry) => entry.id === id) ?? fail("not_found", "There is no such backend.");
  if (backend.builtIn) fail("invalid", `${backend.label} is built in and cannot be removed.`);
  const running = unfinishedOn(store, id).length;
  if (running) fail("conflict", `${running} generation${running === 1 ? " is" : "s are"} still running on ${backend.label}. Remove it once they finish.`);
  store.backends.remove(id);
}

/** Records a real successful run of a recipe on a backend. Never throws: a run is not undone by bookkeeping. */
export function markVerifiedRun(store: Store, backendId: string, recipeId: string, now: number): void {
  try {
    const date = new Date(now).toISOString().slice(0, 10);
    store.backends.update(backendId, (backend) => (backend.verified[recipeId] === date ? backend : { ...backend, verified: { ...backend.verified, [recipeId]: date }, updatedAt: now }));
  } catch {
    // A missing or unreadable row leaves the run as it is.
  }
}
