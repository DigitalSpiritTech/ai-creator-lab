/**
 * The server's view of the plugins: the installed content plugins plus server-only contributions
 * (the starter prompt renderers, and each content plugin's server half: its tools, piece body
 * schemas, and assistant). The tools layer renders prompts with `serverPlugins`, appends its
 * recipes to the catalog, and adds its plugin tools to the roster. Kept out of the browser bundle.
 * @packageDocumentation
 */
import { socialPostServerPlugin } from "@creator-lab/content-social-post/server";
import type { PluginDefinition } from "@creator-lab/core/registry";
import { starterRecipesPlugin } from "@creator-lab/recipes/plugin";
import { INSTALLED_PLUGINS } from "@/plugins/installed";
import { buildRegistry } from "@/plugins/registry";

/** Server-only plugins (renderers, recipes), registered before the content plugins. */
export const SERVER_PLUGINS: readonly PluginDefinition[] = [starterRecipesPlugin];

/**
 * Server halves of installed content plugins: the same manifest plus tools, piece schemas, and an
 * assistant. Each replaces the data-only entry with the same id in `INSTALLED_PLUGINS`.
 */
export const SERVER_PARTS: readonly PluginDefinition[] = [socialPostServerPlugin];

/** The installed plugins as the server registers them: each with its server half when it has one. */
export function serverDefinitions(installed: readonly PluginDefinition[] = INSTALLED_PLUGINS, parts: readonly PluginDefinition[] = SERVER_PARTS): PluginDefinition[] {
  return installed.map((definition) => parts.find((part) => part.id === definition.id) ?? definition);
}

export const serverPlugins = buildRegistry<never>([...SERVER_PLUGINS, ...serverDefinitions()]);
