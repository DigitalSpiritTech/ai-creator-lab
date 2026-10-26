/**
 * Builds the production generation context: executors wired to the store and the user's Comfy key,
 * and the starter recipe catalog read once from `workflows/`. The key comes from the environment,
 * then from Settings (`<dataDir>/secrets.json`).
 * @packageDocumentation
 */
import { resolve } from "node:path";
import type { Recipe } from "@/lib/catalog";
import { defaultRecipes } from "@/server/catalog/defaults";
import { createExecutors } from "@/server/executors";
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
  const workflowsDir = options.workflowsDir ?? resolve(/* turbopackIgnore: true */ process.cwd(), "workflows");
  const apiKey = readSecrets(store.dataDir).comfyApiKey;
  const key = `${workflowsDir}\n${apiKey ?? ""}`;
  const forStore = cache.get(store) ?? new Map<string, GenerationContext>();
  cache.set(store, forStore);
  const cached = forStore.get(key);
  if (cached) return cached;
  let catalog: Promise<Recipe[]> | undefined;
  const context: GenerationContext = {
    executors: createExecutors({ jobs: store.jobs, mediaRoot: store.dataDir, apiKey, workflowsDir }),
    recipes: () => {
      catalog ??= defaultRecipes(workflowsDir);
      return catalog;
    },
  };
  forStore.clear();
  forStore.set(key, context);
  return context;
}
