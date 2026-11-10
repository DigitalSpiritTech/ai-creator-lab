/**
 * The Backends section of Settings: every backend with its last probe, whether it can be used with
 * the keys set now, and each recipe's status per backend (verified, compatible, unavailable with the
 * missing nodes and models, or not checked). Carries no key, only whether one is set.
 * @packageDocumentation
 */
import "server-only";
import { resolve } from "node:path";
import {
  type Backend,
  BackendIdSchema,
  type Recipe,
  type RecipeBackendStatus,
  backendUsable,
  defaultWorkflowBackend,
  recipeStatusOn,
} from "@/lib/catalog";
import { listBackends } from "@/server/catalog/backends";
import { type ProbeOptions, probeAndSave } from "@/server/catalog/backend-probe";
import { hostedMode } from "@/server/demo";
import { readSecrets } from "@/server/secrets";
import type { Store } from "@/server/store";
import { generationFor } from "@/app/api/_lib/server";

export interface BackendRow extends Backend {
  usable: boolean;
  /** Why the backend cannot be used now, for example a missing key. */
  usableNote: string | null;
  isDefault: boolean;
}

export interface BackendsView {
  backends: BackendRow[];
  defaultBackendId: string | null;
  recipes: { id: string; title: string; kind: Recipe["kind"]; capability: Recipe["capability"]; statuses: Record<string, RecipeBackendStatus> }[];
  /** False on a hosted copy, where only Comfy Cloud and Router are offered. */
  customAllowed: boolean;
}

async function catalog(store: Store): Promise<Recipe[]> {
  return (await generationFor(store).recipes()).filter((recipe) => recipe.kind !== "mock");
}

export async function backendsView(store: Store): Promise<BackendsView> {
  const hasComfyKey = !!readSecrets(store.dataDir).comfyApiKey;
  const backends = listBackends(store);
  const preferred = defaultWorkflowBackend(backends);
  const recipes = await catalog(store);
  return {
    backends: backends.map((backend) => {
      const usable = backendUsable(backend, hasComfyKey);
      return { ...backend, usable: usable.ok, usableNote: usable.ok ? null : usable.reason, isDefault: backend.id === preferred?.id };
    }),
    defaultBackendId: preferred?.id ?? null,
    recipes: recipes.map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      kind: recipe.kind,
      capability: recipe.capability,
      statuses: Object.fromEntries(backends.map((backend) => [backend.id, recipeStatusOn(recipe, backend)])),
    })),
    customAllowed: !hostedMode(),
  };
}

/** Probes one backend (free: reads object_info or Router's model list, submits nothing) and saves the result. */
export async function probeStored(store: Store, backendId: string, extra: Partial<ProbeOptions> = {}): Promise<Backend> {
  const apiKey = readSecrets(store.dataDir).comfyApiKey;
  const workflowsDir = resolve(/* turbopackIgnore: true */ process.cwd(), "workflows");
  return probeAndSave(store, backendId, await catalog(store), { apiKey, workflowsDir, ...extra });
}

/** A backend id from a route parameter; anything else is a 404. */
export function parseBackendId(value: string): string {
  const parsed = BackendIdSchema.safeParse(value);
  if (!parsed.success) throw Response.json({ error: "There is no such backend." }, { status: 404 });
  return parsed.data;
}
