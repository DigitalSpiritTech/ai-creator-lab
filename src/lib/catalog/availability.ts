/**
 * Per-recipe availability on each backend, and where a recipe runs. Pure: the backend list and the
 * key status come in, decisions come out. The server binds the chosen backend onto the recipe
 * snapshot a proposal and its jobs carry.
 *
 * A workflow runs on the default backend when that backend can run it. When it cannot (the probe
 * found missing nodes or models, or the backend needs a key that is not set), it falls back to
 * Comfy Cloud, and the placement says so, so the proposal can tell the person. When Cloud cannot
 * run it either, the placement refuses with the reason.
 * @packageDocumentation
 */
import {
  type Backend,
  type BackendRouting,
  CLOUD_BACKEND_ID,
  ROUTER_BACKEND_ID,
  backendUsable,
  defaultWorkflowBackend,
  isWorkflowBackend,
} from "@/lib/catalog/backends";
import type { Recipe } from "@/lib/catalog/recipes";

export type RecipeBackendStatus =
  /** A real run succeeded here (for Cloud, also the catalog's verified date). */
  | { status: "verified"; date: string }
  /** The last probe found every node class and model file the recipe needs. */
  | { status: "compatible" }
  /** Not known: never probed, the probe failed, or the recipe was added after the last probe. */
  | { status: "unchecked"; reason: string }
  /** The last probe found the backend lacks these. */
  | { status: "unavailable"; nodes: string[]; models: string[] }
  /** This kind of recipe does not run on this kind of backend (a workflow on Router, say). */
  | { status: "not_applicable" };

type RecipeFacts = Pick<Recipe, "id" | "kind" | "verified">;

function runsOn(recipe: Pick<Recipe, "kind">, backend: Pick<Backend, "kind">): boolean {
  if (recipe.kind === "router") return backend.kind === "router";
  if (recipe.kind === "workflow") return isWorkflowBackend(backend);
  return false;
}

/** What the backend's last probe and run history say about one recipe. */
export function recipeStatusOn(recipe: RecipeFacts, backend: Backend): RecipeBackendStatus {
  if (!runsOn(recipe, backend)) return { status: "not_applicable" };
  const probe = backend.lastProbe;
  const missing = probe?.ok ? probe.missing[recipe.id] : undefined;
  if (missing && (missing.nodes.length || missing.models.length)) return { status: "unavailable", nodes: missing.nodes, models: missing.models };
  // The catalog's verified date is a run on Comfy Cloud (workflows) or on Router (hosted models).
  const catalogVerified = backend.kind === "cloud" || backend.kind === "router" ? recipe.verified : null;
  const date = [backend.verified[recipe.id], catalogVerified].filter((value): value is string => !!value).sort().at(-1);
  if (date) return { status: "verified", date };
  if (probe?.ok && probe.checked.includes(recipe.id)) return { status: "compatible" };
  if (!probe) return { status: "unchecked", reason: "not probed yet" };
  if (!probe.ok) return { status: "unchecked", reason: `the last probe failed${probe.error ? `: ${probe.error}` : ""}` };
  return { status: "unchecked", reason: "added after the last probe" };
}

/** Verified, compatible, and unchecked recipes may run; only a probe's evidence rules one out. */
export function statusAllowsRun(status: RecipeBackendStatus): boolean {
  return status.status === "verified" || status.status === "compatible" || status.status === "unchecked";
}

function list(names: string[], max = 6): string {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

/** "missing nodes A, B; missing models x.safetensors" for an unavailable status. */
export function describeMissing(status: Extract<RecipeBackendStatus, { status: "unavailable" }>): string {
  const parts: string[] = [];
  if (status.nodes.length) parts.push(`missing node${status.nodes.length === 1 ? "" : "s"} ${list(status.nodes)}`);
  if (status.models.length) parts.push(`missing model${status.models.length === 1 ? "" : "s"} ${list(status.models)}`);
  return parts.join("; ");
}

export type Placement =
  | {
      ok: true;
      /** The backend the run is bound to; null for mock recipes. */
      backend: Backend | null;
      /** Set when the default backend could not run the recipe and Comfy Cloud runs it instead. */
      fallbackFrom?: { id: string; label: string; reason: string };
    }
  | { ok: false; reason: string };

function whyNot(recipe: RecipeFacts, backend: Backend, hasComfyKey: boolean): string | null {
  const usable = backendUsable(backend, hasComfyKey);
  if (!usable.ok) return usable.reason;
  const status = recipeStatusOn(recipe, backend);
  if (status.status === "unavailable") return describeMissing(status);
  if (status.status === "not_applicable") return "does not run this kind of recipe";
  return null;
}

/**
 * Where a recipe runs. `backendId` pins a backend (a proposal already bound to one): then there is
 * no fallback, and a backend that can no longer run the recipe is a refusal. Without it the default
 * workflow backend is tried, then Comfy Cloud.
 */
export function placeRecipe(recipe: Pick<Recipe, "id" | "kind" | "verified" | "title">, routing: BackendRouting, backendId?: string): Placement {
  if (recipe.kind === "mock") return { ok: true, backend: null };
  const { backends, hasComfyKey } = routing;
  if (recipe.kind === "router") {
    const router = backends.find((backend) => backend.id === ROUTER_BACKEND_ID);
    if (!router) return hasComfyKey ? { ok: true, backend: null } : { ok: false, reason: `${recipe.title} needs a Comfy API key in Settings before it can run.` };
    const reason = whyNot(recipe, router, hasComfyKey);
    return reason ? { ok: false, reason: `${recipe.title} cannot run on ${router.label}: ${reason}.` } : { ok: true, backend: router };
  }
  const pinned = backendId !== undefined;
  const preferred = pinned ? backends.find((backend) => backend.id === backendId) : defaultWorkflowBackend(backends);
  if (!preferred) {
    return { ok: false, reason: pinned ? "The backend this proposal was made for is no longer in Settings. Propose it again." : "No workflow backend is set up. Add a Comfy API key or a backend in Settings." };
  }
  if (!isWorkflowBackend(preferred)) return { ok: false, reason: `${preferred.label} does not run workflows.` };
  const reason = whyNot(recipe, preferred, hasComfyKey);
  if (!reason) return { ok: true, backend: preferred };
  const refused = `${recipe.title} cannot run on ${preferred.label}: ${reason}`;
  if (pinned || preferred.id === CLOUD_BACKEND_ID) return { ok: false, reason: `${refused}.${pinned ? " Propose it again." : ""}` };
  const cloud = backends.find((backend) => backend.id === CLOUD_BACKEND_ID);
  const cloudReason = cloud ? whyNot(recipe, cloud, hasComfyKey) : "is not configured";
  if (cloud && !cloudReason) return { ok: true, backend: cloud, fallbackFrom: { id: preferred.id, label: preferred.label, reason } };
  return { ok: false, reason: `${refused}, and Comfy Cloud ${cloudReason}.` };
}

/** Every recipe of the list with where it would run, in the list's order. */
export function placeRecipes<T extends Pick<Recipe, "id" | "kind" | "verified" | "title">>(recipes: readonly T[], routing: BackendRouting): { recipe: T; placement: Placement }[] {
  return recipes.map((recipe) => ({ recipe, placement: placeRecipe(recipe, routing) }));
}

/**
 * The text a proposal shows about its backend: the fallback and why, or the self-hosted server's
 * name. Empty when the run goes where it always would (Comfy Cloud, Router, the mock).
 */
export function placementNote(placement: Placement): string {
  if (!placement.ok || !placement.backend) return "";
  if (placement.fallbackFrom) return `Runs on ${placement.backend.label} because ${placement.fallbackFrom.label} cannot run it (${placement.fallbackFrom.reason}).`;
  if (placement.backend.kind === "comfyui" || placement.backend.kind === "deployment") return `Runs on ${placement.backend.label}.`;
  return "";
}

/** The recipe title for a run on a backend other than Comfy Cloud: "... on <label>". */
export function placedTitle(recipe: Pick<Recipe, "title" | "kind">, backend: Backend | null): string {
  if (recipe.kind !== "workflow" || !backend || backend.kind === "cloud") return recipe.title;
  return `${recipe.title.replace(/ on Comfy Cloud$/, "")} on ${backend.label}`.slice(0, 120);
}

/** The recipe snapshot bound to its backend (workflow recipes only). */
export function bindRecipe<T extends Recipe>(recipe: T, backend: Backend | null): T {
  if (recipe.kind !== "workflow" || !backend) return recipe;
  return { ...recipe, backendId: backend.id };
}
