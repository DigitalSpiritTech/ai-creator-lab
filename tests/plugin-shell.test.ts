/**
 * The F8 seam: a content type registered through the app's registry appears in the shell (the
 * Projects page's App list, the project header's App label, and the workspace's tabs and panel)
 * without any change to shell code. Runs in its own process, so the throwaway plugin never leaks
 * into other tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type PanelHost, type PanelProps, definePlugin } from "@creator-lab/core/registry";
import { WorkspacePanels } from "@/components/project/workspace-panels";
import { appPlugins } from "@/plugins/panels";
import { appChoices, appLabel } from "@/plugins/registry";

const throwaway = definePlugin({
  id: "throwaway",
  label: "Throwaway",
  contentTypes: [
    { id: "jingle", label: "Jingle", app: { id: "jingle-maker", label: "Jingle Maker" }, description: "A ten second audio sting.", pieceType: "jingle", defaultPanel: "throwaway.lyrics" },
  ],
  steps: [{ id: "lyrics", contentType: "jingle", number: 1, title: "Lyrics", tools: ["get_project_state"], panel: "throwaway.lyrics" }],
  panels: [
    { id: "throwaway.mix", contentType: "jingle", title: "Mix", order: 20 },
    { id: "throwaway.lyrics", contentType: "jingle", title: "Lyrics", order: 10 },
  ],
});

function Lyrics({ host }: PanelProps) {
  return createElement("p", { "data-panel": "lyrics" }, `Lyrics for ${host.projectId} (${host.contentTypeId})`);
}

function Mix() {
  return createElement("p", { "data-panel": "mix" }, "Mixing desk");
}

const host: PanelHost = {
  projectId: "p-1",
  contentTypeId: "jingle",
  openPanel: () => undefined,
  refresh: async () => undefined,
  notify: () => undefined,
  callTool: async () => undefined as never,
};

const render = (contentTypeId: string, active: string | null) => renderToStaticMarkup(createElement(WorkspacePanels, { contentTypeId, active, onSelect: () => undefined, host }));

test("a throwaway content type appears in the shell's App list and workspace with no shell change", () => {
  assert.deepEqual(appChoices().map((app) => app.label), ["UGC Creator"]);
  assert.equal(appLabel("jingle-maker"), "jingle-maker", "an App without a plugin shows its id");

  appPlugins.registerPlugin(throwaway);
  appPlugins.registerPanelComponents({ "throwaway.lyrics": Lyrics, "throwaway.mix": Mix });

  assert.deepEqual(appChoices(), [
    { id: "ugc-creator", label: "UGC Creator", contentTypes: ["ad"] },
    { id: "jingle-maker", label: "Jingle Maker", contentTypes: ["jingle"] },
  ]);
  assert.equal(appLabel("jingle-maker"), "Jingle Maker");
  assert.equal(appPlugins.contentTypeForApp("jingle-maker")?.id, "jingle");

  const opened = render("jingle", null);
  assert.match(opened, /role="tab" aria-selected="true"[^>]*>Lyrics<\/button>.*>Mix<\/button>/, "tabs in panel order, the default selected");
  assert.match(opened, /<p data-panel="lyrics">Lyrics for p-1 \(jingle\)<\/p>/);
  assert.doesNotMatch(opened, /Mixing desk/);

  const mixing = render("jingle", "throwaway.mix");
  assert.match(mixing, /<p data-panel="mix">Mixing desk<\/p>/);
  assert.match(render("jingle", "ugc-ad.script"), /data-panel="lyrics"/, "a panel of another content type falls back to the default");
});

test("UGC Ad's workspace still has its five tabs, each with a component", () => {
  const panels = appPlugins.resolvePanels("ad");
  assert.deepEqual(panels.map(({ panel }) => panel.title), ["Documents", "Script", "Shots", "Assets", "Export"]);
  assert.ok(panels.every(({ component }) => typeof component === "function"));
});

test("a declared panel without a component says so instead of failing", () => {
  appPlugins.registerPlugin({
    id: "half-done",
    label: "Half done",
    contentTypes: [{ id: "memo", label: "Memo", app: { id: "memo-pad", label: "Memo Pad" }, description: "A memo.", pieceType: "memo", defaultPanel: "half-done.edit" }],
    panels: [{ id: "half-done.edit", contentType: "memo", title: "Edit" }],
  });
  assert.match(render("memo", null), /The Edit panel is not available in this build\./);
});
