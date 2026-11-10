/**
 * This package as a plugin: the starter prompt renderers for every prompt style. The starter
 * recipes themselves are read from `workflows/` at run time ({@link defaultRecipes}) because their
 * sidecars are checked against the graphs on disk, so they are not part of the static manifest.
 * @packageDocumentation
 */
import { definePlugin } from "@creator-lab/core/registry";
import { STARTER_RENDERERS } from "./render";

export const starterRecipesPlugin = definePlugin({
  id: "starter-recipes",
  label: "Starter recipes and prompt renderers",
  renderers: [...STARTER_RENDERERS],
});
