/**
 * The app's plugin registry, `appPlugins`: the installed content plugins (data only, safe in the
 * browser). The project shell and the Projects page read content types and panels from it;
 * `panels.tsx` attaches each panel's component in the browser, and `server.ts` builds the
 * server's registry with the prompt renderers for the tools layer.
 * @packageDocumentation
 */
import type { ComponentType } from "react";
import { type PanelProps, type PluginDefinition, type PluginRegistry, createPluginRegistry } from "@creator-lab/core/registry";
import { INSTALLED_PLUGINS } from "@/plugins/installed";

/** What draws a workspace panel. */
export type PanelComponent = ComponentType<PanelProps>;

/** A registry holding `definitions` in order. */
export function buildRegistry<C = PanelComponent>(definitions: readonly PluginDefinition[]): PluginRegistry<C> {
  const registry = createPluginRegistry<C>();
  for (const definition of definitions) registry.registerPlugin(definition);
  return registry;
}

/** The installed content types, steps, and panels (components are added by `panels.tsx`). */
export const appPlugins: PluginRegistry<PanelComponent> = buildRegistry(INSTALLED_PLUGINS);

/** One App a project can be created from, with the content types made in it. */
export interface AppChoice {
  id: string;
  label: string;
  contentTypes: string[];
}

/** The Apps to offer on the Projects page, in registration order. */
export function appChoices(registry: Pick<PluginRegistry<unknown>, "contentTypes"> = appPlugins): AppChoice[] {
  const apps = new Map<string, AppChoice>();
  for (const type of registry.contentTypes()) {
    const app = apps.get(type.app.id) ?? { id: type.app.id, label: type.app.label, contentTypes: [] };
    app.contentTypes.push(type.id);
    apps.set(app.id, app);
  }
  return [...apps.values()];
}

/** The label of a project's App ("UGC Creator"), or its id when no installed plugin names it. */
export function appLabel(appId: string, registry: Pick<PluginRegistry<unknown>, "contentTypeForApp"> = appPlugins): string {
  return registry.contentTypeForApp(appId)?.app.label ?? appId;
}
