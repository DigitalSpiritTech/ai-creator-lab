/**
 * The server's view of the plugins: the installed content plugins plus server-only contributions
 * (the starter prompt renderers today). The tools layer renders prompts with `serverPlugins` and
 * appends its recipes to the catalog. Kept out of the browser bundle: the renderers carry every
 * model's prompt grammar.
 * @packageDocumentation
 */
import type { PluginDefinition } from "@creator-lab/core/registry";
import { starterRecipesPlugin } from "@creator-lab/recipes/plugin";
import { INSTALLED_PLUGINS } from "@/plugins/installed";
import { buildRegistry } from "@/plugins/registry";

/** Server-only plugins (renderers, recipes), registered before the content plugins. */
export const SERVER_PLUGINS: readonly PluginDefinition[] = [starterRecipesPlugin];

export const serverPlugins = buildRegistry<never>([...SERVER_PLUGINS, ...INSTALLED_PLUGINS]);
