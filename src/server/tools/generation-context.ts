/**
 * Builds the production generation context: executors wired to the store and the user's Comfy key,
 * and the starter recipe catalog read once from `workflows/`.
 * @packageDocumentation
 */
import { resolve } from "node:path";
import type { Recipe } from "@/lib/catalog";
import { defaultRecipes } from "@/server/catalog/defaults";
import { createExecutors } from "@/server/executors";
import type { Store } from "@/server/store";
import type { GenerationContext } from "@/server/tools/registry";

export function createGenerationContext(store: Store, options: { workflowsDir?: string } = {}): GenerationContext {
  const workflowsDir = options.workflowsDir ?? resolve(/* turbopackIgnore: true */ process.cwd(), "workflows");
  let catalog: Promise<Recipe[]> | undefined;
  return {
    executors: createExecutors({
      jobs: store.jobs,
      mediaRoot: store.dataDir,
      apiKey: process.env.COMFY_API_KEY,
      workflowsDir,
    }),
    recipes: () => {
      catalog ??= defaultRecipes(workflowsDir);
      return catalog;
    },
  };
}
