/**
 * Backends: the servers recipes run on. Comfy Cloud and Comfy Router are always listed; a
 * self-hosted ComfyUI (usually through the v2 API proxy) or a Comfy API deployment can be added in
 * Settings, and `COMFY_BASE_URL` seeds one so existing installs keep their target. Keys are never
 * stored here: Cloud, Router, and Comfy-hosted deployments use the Comfy API key from the
 * environment or Settings, and a self-hosted ComfyUI gets no key at all.
 *
 * The probe result (`lastProbe`) says what a backend lacks per recipe, from its `object_info` (or
 * Router's model list). `verified` records real successful runs per recipe, kept apart from the
 * probe: a probe says a recipe should run, a run says it did.
 * @packageDocumentation
 */
import { z } from "zod";
import { BackendIdSchema, RecipeIdSchema } from "@/lib/catalog/recipes";

export { BackendIdSchema };
export type BackendId = z.infer<typeof BackendIdSchema>;

export const BackendKindSchema = z.enum(["cloud", "comfyui", "deployment", "router"]);
export type BackendKind = z.infer<typeof BackendKindSchema>;

/** The kinds that run workflow recipes. */
export const WORKFLOW_BACKEND_KINDS: readonly BackendKind[] = ["cloud", "comfyui", "deployment"];

export const COMFY_CLOUD_URL = "https://cloud.comfy.org";
export const COMFY_ROUTER_URL = "https://api.comfy.org";

export const CLOUD_BACKEND_ID = "cloud";
export const ROUTER_BACKEND_ID = "router";
/** The backend seeded from `COMFY_BASE_URL`. */
export const ENV_BACKEND_ID = "env";

export const BACKEND_KIND_LABELS: Record<BackendKind, string> = {
  cloud: "Comfy Cloud",
  comfyui: "Self-hosted ComfyUI",
  deployment: "Comfy API deployment",
  router: "Comfy Router",
};

/**
 * Normalizes a backend URL: http or https, a host, no user name or password, no query or fragment,
 * trailing slashes removed. Returns a readable problem instead of throwing.
 */
export function normalizeBackendUrl(raw: string): { ok: true; url: string } | { ok: false; problem: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, problem: "Enter the backend's address, for example http://127.0.0.1:8189." };
  if (trimmed.length > 300) return { ok: false, problem: "That address is too long." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, problem: "That is not a web address. Use one like http://127.0.0.1:8189." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, problem: "Use an http or https address." };
  if (!parsed.hostname) return { ok: false, problem: "The address needs a host name." };
  if (parsed.username || parsed.password) return { ok: false, problem: "Leave the user name and password out of the address." };
  if (parsed.search || parsed.hash || /[?#]/.test(trimmed)) return { ok: false, problem: "Leave the query and fragment (? and #) out of the address." };
  return { ok: true, url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}` };
}

export const BackendUrlSchema = z
  .string()
  .max(300)
  .superRefine((value, context) => {
    const normalized = normalizeBackendUrl(value);
    if (!normalized.ok) context.addIssue({ code: "custom", message: normalized.problem });
  })
  .transform((value) => {
    const normalized = normalizeBackendUrl(value);
    return normalized.ok ? normalized.url : value;
  });

/**
 * Whether a URL is a Comfy-operated host (Comfy Cloud, `*.comfy.org`, or a `*.comfy.app`
 * deployment) over https. Only these ever receive the Comfy API key.
 */
export function isComfyHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === "comfy.org" || host.endsWith(".comfy.org") || host.endsWith(".comfy.app"));
  } catch {
    return false;
  }
}

/**
 * What keeps one recipe off a backend: node classes and model files it lacks, and, on any backend
 * but Comfy Cloud, partner (API) nodes the graph uses. A partner node bills the Comfy account
 * signed in to that ComfyUI, outside this app's budget, so it rules the recipe out there.
 */
export const RecipeMissingSchema = z
  .object({
    nodes: z.array(z.string().min(1).max(200)).max(200),
    models: z.array(z.string().min(1).max(300)).max(200),
    partnerNodes: z.array(z.string().min(1).max(200)).max(200).default([]),
  })
  .strict();
export type RecipeMissing = z.infer<typeof RecipeMissingSchema>;

export const BackendProbeSchema = z
  .object({
    at: z.number().int().nonnegative(),
    ok: z.boolean(),
    /** Why the probe failed, in words a person can act on. */
    error: z.string().max(400).optional(),
    /** Node classes (ComfyUI) or models (Router) the backend listed. */
    nodeClasses: z.number().int().nonnegative(),
    /** Recipes the probe compared. A recipe added later reads as not checked. */
    checked: z.array(RecipeIdSchema).max(2000),
    /** Per recipe, what the backend lacks. A checked recipe with no entry is compatible. */
    missing: z.record(RecipeIdSchema, RecipeMissingSchema),
  })
  .strict();
export type BackendProbe = z.infer<typeof BackendProbeSchema>;

export const BackendSchema = z
  .object({
    id: BackendIdSchema,
    kind: BackendKindSchema,
    label: z.string().trim().min(1).max(80),
    baseUrl: BackendUrlSchema,
    /** Workflows run here unless a recipe cannot; at most one backend carries it. */
    default: z.boolean().default(false),
    /** Comfy Cloud, Comfy Router, and the COMFY_BASE_URL entry cannot be removed in Settings. */
    builtIn: z.boolean().default(false),
    lastProbe: BackendProbeSchema.nullable().default(null),
    /** Recipe id to the ISO date of its last successful run on this backend. */
    verified: z.record(RecipeIdSchema, z.iso.date()).default({}),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type Backend = z.infer<typeof BackendSchema>;

/** Adding a backend in Settings. Cloud and Router are always listed, so only these two kinds are added. */
export const NewBackendSchema = z
  .object({
    kind: z.enum(["comfyui", "deployment"]),
    label: z.string().trim().min(1).max(80),
    baseUrl: BackendUrlSchema,
  })
  .strict();
export type NewBackend = z.infer<typeof NewBackendSchema>;

export const UpdateBackendSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    /** Make this the backend workflows run on. */
    default: z.literal(true).optional(),
  })
  .strict();
export type UpdateBackend = z.infer<typeof UpdateBackendSchema>;

export function isWorkflowBackend(backend: Pick<Backend, "kind">): boolean {
  return WORKFLOW_BACKEND_KINDS.includes(backend.kind);
}

/**
 * The backend workflows run on: the one marked default, else the COMFY_BASE_URL entry, else Comfy
 * Cloud. That keeps an install that set COMFY_BASE_URL on the same server it used before.
 */
export function defaultWorkflowBackend(backends: readonly Backend[]): Backend | undefined {
  const workflow = backends.filter(isWorkflowBackend);
  return (
    workflow.find((backend) => backend.default) ??
    workflow.find((backend) => backend.id === ENV_BACKEND_ID) ??
    workflow.find((backend) => backend.id === CLOUD_BACKEND_ID) ??
    workflow[0]
  );
}

/**
 * Whether a backend can be used with the keys configured now. Cloud, Router, and Comfy-hosted
 * deployments need the Comfy API key; a self-hosted ComfyUI or a deployment on another host does not.
 */
export function backendUsable(backend: Pick<Backend, "kind" | "baseUrl">, hasComfyKey: boolean): { ok: true } | { ok: false; reason: string } {
  const needsKey = backend.kind === "cloud" || backend.kind === "router" || (backend.kind === "deployment" && isComfyHost(backend.baseUrl));
  if (needsKey && !hasComfyKey) return { ok: false, reason: "needs a Comfy API key in Settings" };
  return { ok: true };
}

/** The data the availability and placement rules read: the backend list and whether a Comfy key is set. */
export interface BackendRouting {
  backends: readonly Backend[];
  hasComfyKey: boolean;
}
