/**
 * The workspace beside the chat: one tab per panel of the project's content type, read from the
 * plugin registry, and the active panel's component. Nothing here names a content type, so a new
 * plugin's panels appear without a change to this file.
 * @packageDocumentation
 */
"use client";

import type { PanelHost, PluginRegistry } from "@creator-lab/core/registry";
import { Button } from "@creator-lab/ui/button";
import { cn } from "@creator-lab/ui/utils";
import { appPlugins } from "@/plugins/panels";
import type { PanelComponent } from "@/plugins/registry";

export interface WorkspacePanelsProps {
  contentTypeId: string;
  /** The selected panel id; the content type's default panel when null or unknown. */
  active: string | null;
  onSelect(panelId: string): void;
  host: PanelHost;
  /** The registry to read; the app's own by default. */
  registry?: Pick<PluginRegistry<PanelComponent>, "contentType" | "resolvePanels">;
}

/** The panel a workspace shows: the selected one if it belongs to the content type, else its default. */
export function activePanelId(registry: Pick<PluginRegistry<unknown>, "contentType">, contentTypeId: string, active: string | null): string | undefined {
  const type = registry.contentType(contentTypeId);
  if (!type) return undefined;
  return type.panels.some((panel) => panel.id === active) ? (active ?? undefined) : type.defaultPanel;
}

export function WorkspacePanels({ contentTypeId, active, onSelect, host, registry = appPlugins }: WorkspacePanelsProps) {
  const panels = registry.resolvePanels(contentTypeId);
  const selected = activePanelId(registry, contentTypeId, active);
  const current = panels.find((entry) => entry.panel.id === selected);
  const Panel = current?.component;
  return (
    <section className="flex min-h-0 flex-col" aria-label="Workspace">
      <div className="flex gap-1 border-b p-2" role="tablist">
        {panels.map(({ panel }) => (
          <Button key={panel.id} size="sm" variant={panel.id === selected ? "secondary" : "ghost"} role="tab" aria-selected={panel.id === selected} onClick={() => onSelect(panel.id)}>
            {panel.title}
          </Button>
        ))}
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto p-5")}>
        {Panel ? <Panel host={host} /> : current ? <p className="text-sm text-muted-foreground">The {current.panel.title} panel is not available in this build.</p> : null}
      </div>
    </section>
  );
}
