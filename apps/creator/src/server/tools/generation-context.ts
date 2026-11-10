/**
 * Builds the production generation context: executors wired to the store and the user's Comfy key,
 * and the starter recipe catalog read once from `workflows/`. The key comes from the environment,
 * then from Settings (`<dataDir>/secrets.json`).
 * @packageDocumentation
 */
import { defaultWorkflowsDir } from "@creator-lab/recipes/workflows-dir";
import type { Recipe } from "@creator-lab/core/catalog";
import { backendRouting, listBackends } from "@/server/catalog/backends";
import { defaultRecipes } from "@creator-lab/recipes/defaults";
import { adapterRecipes } from "@creator-lab/recipes/router-adapters";
import { createExecutors } from "@creator-lab/executors";
import { serverPlugins } from "@/plugins/server";
import { readSecrets } from "@/server/secrets";
import type { Store } from "@/server/store";
import type { GenerationContext } from "@/server/tools/registry";

const cache = new WeakMap<Store, Map<string, GenerationContext>>();

/**
 * The generation context for a store. One instance per store, key, and workflows folder, so every
 * caller in the process (routes, the agent, restart recovery) shares the same executors and the
 * Router executor's record of calls in flight.
 */
export function createGenerationContext(store: Store, options: { workflowsDir?: string } = {}): GenerationContext {
  const workflowsDir = options.workflowsDir ?? defaultWorkflowsDir();
  const apiKey = readSecrets(store.dataDir).comfyApiKey;
  const key = `${workflowsDir}\n${apiKey ?? ""}`;
  const forStore = cache.get(store) ?? new Map<string, GenerationContext>();
  cache.set(store, forStore);
  const cached = forStore.get(key);
  if (cached) return cached;
  let catalog: Promise<Recipe[]> | undefined;
  const context: GenerationContext = {
    executors: createExecutors({ jobs: store.jobs, mediaRoot: store.dataDir, apiKey, workflowsDir, backends: () => listBackends(store) }),
    routing: () => backendRouting(store, !!apiKey),
    recipes: async () => {
      catalog ??= defaultRecipes(workflowsDir);
      const starters = await catalog;
      // Router models the user switched on in Settings add their adapter recipes after the starters,
      // then recipes from plugins; an id already listed keeps its first definition.
      const known = new Set(starters.map((recipe) => recipe.id));
      const extra: Recipe[] = [];
      for (const recipe of [...adapterRecipes(store.workspace.get().routerModels), ...serverPlugins.recipes()]) {
        if (known.has(recipe.id)) continue;
        known.add(recipe.id);
        extra.push(recipe);
      }
      return [...starters, ...extra];
    },
  };
  forStore.clear();
  forStore.set(key, context);
  return context;
}
