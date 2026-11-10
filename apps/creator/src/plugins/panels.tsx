/**
 * Attaches a component to each installed panel in the browser and re-exports the app registry
 * with them. The project shell imports the registry from here so the components are in place.
 *
 * A plugin package that ships its own panels exports a `Record<panelId, PanelComponent>` that is
 * registered here. UGC Ad's panels are app components because they share the project context and
 * the candidate cards.
 * @packageDocumentation
 */
"use client";

import { UGC_AD_PANELS } from "@creator-lab/content-ugc-ad";
import type { PanelProps } from "@creator-lab/core/registry";
import { AssetsTab } from "@/components/project/assets-tab";
import { DocumentsTab } from "@/components/project/documents-tab";
import { ExportTab } from "@/components/project/export-tab";
import { ScriptTab } from "@/components/project/script-tab";
import { ShotsTab } from "@/components/project/shots-tab";
import { type PanelComponent, appPlugins } from "@/plugins/registry";

function UgcAdDocuments({ host }: PanelProps) {
  return <DocumentsTab openScript={() => host.openPanel(UGC_AD_PANELS.script)} />;
}

const UGC_AD_PANEL_COMPONENTS: Record<string, PanelComponent> = {
  [UGC_AD_PANELS.documents]: UgcAdDocuments,
  [UGC_AD_PANELS.script]: ScriptTab,
  [UGC_AD_PANELS.shots]: ShotsTab,
  [UGC_AD_PANELS.assets]: AssetsTab,
  [UGC_AD_PANELS.export]: ExportTab,
};

appPlugins.registerPanelComponents(UGC_AD_PANEL_COMPONENTS);

export { appPlugins };
