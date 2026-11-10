/**
 * The installed content plugins, in registration order. This list and the panel components in
 * `panels.tsx` are the only places a content type is named; the project shell, the project list,
 * and the tools layer read everything else from the registry.
 *
 * Definitions listed here reach the browser, so they must be data only (content types, steps,
 * panels, recipes). Prompt renderers, plugin tools, piece schemas, and assistants go in `server.ts`
 * (`SERVER_PLUGINS`, or a plugin's server half in `SERVER_PARTS`).
 * @packageDocumentation
 */
import { socialPostPlugin } from "@creator-lab/content-social-post";
import { ugcAdPlugin } from "@creator-lab/content-ugc-ad";
import type { PluginDefinition } from "@creator-lab/core/registry";

export const INSTALLED_PLUGINS: readonly PluginDefinition[] = [ugcAdPlugin, socialPostPlugin];
