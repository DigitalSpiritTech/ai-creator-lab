/**
 * The plugin registry (F8 phase A): registration rules, resolution order, renderers and recipes
 * through the registry, and UGC Ad as a registered content type whose steps match the tools
 * roster and the creative director's stages.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { QUICK_AD_MODE, UGC_AD_PANELS, UGC_AD_STEPS, ugcAdPlugin } from "@creator-lab/content-ugc-ad";
import type { PromptStyle } from "@creator-lab/core/catalog";
import { type PluginDefinition, createPluginRegistry, definePlugin } from "@creator-lab/core/registry";
import { STARTER_RENDERERS, renderPrompt } from "@creator-lab/recipes/render";
import { starterRecipesPlugin } from "@creator-lab/recipes/plugin";
import { appChoices, appLabel, appPlugins } from "@/plugins/registry";
import { serverPlugins } from "@/plugins/server";
import { stepOf } from "@/server/agent/state";
import { INTERNAL_TOOLS, TOOLS } from "@/server/tools";
import { CLIP_CASES, IMAGE_CASES, renderSpecs, styleRecipe } from "./support/render-cases";

function notePlugin(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return definePlugin({
    id: "notes",
    label: "Notes",
    contentTypes: [{ id: "note", label: "Note", app: { id: "note-taker", label: "Note Taker" }, description: "A short written note.", pieceType: "note", defaultPanel: "notes.editor" }],
    steps: [
      { id: "review", contentType: "note", number: 2, title: "Review", panel: "notes.editor" },
      { id: "write", contentType: "note", number: 1, title: "Write", tools: ["get_project_state"], panel: "notes.editor" },
    ],
    panels: [
      { id: "notes.preview", contentType: "note", title: "Preview", order: 20 },
      { id: "notes.editor", contentType: "note", title: "Editor", order: 10 },
    ],
    ...overrides,
  });
}

describe("plugin registry", () => {
  test("resolves a content type with its steps by flow number and its panels by order", () => {
    const registry = createPluginRegistry();
    const manifest = registry.registerPlugin(notePlugin());
    assert.deepEqual(manifest.recipes, []);
    const note = registry.contentType("note");
    assert.ok(note);
    assert.equal(note.plugin, "notes");
    assert.deepEqual(note.steps.map((step) => step.id), ["write", "review"]);
    assert.deepEqual(note.steps[1].tools, [], "tools default to none");
    assert.deepEqual(note.panels.map((panel) => panel.title), ["Editor", "Preview"]);
    assert.equal(registry.contentTypeForApp("note-taker")?.id, "note");
    assert.equal(registry.contentTypeForApp("unknown"), undefined);
    assert.equal(registry.step("note", "review")?.number, 2);
  });

  test("another plugin can add a step and a panel to an existing content type", () => {
    const registry = createPluginRegistry<string>();
    registry.registerPlugin(notePlugin());
    registry.registerPlugin({
      id: "note-extras",
      label: "Note extras",
      steps: [{ id: "publish", contentType: "note", number: 3, title: "Publish", panel: "note-extras.share" }],
      panels: [{ id: "note-extras.share", contentType: "note", title: "Share", order: 15 }],
    });
    const note = registry.contentType("note")!;
    assert.deepEqual(note.steps.map((step) => step.id), ["write", "review", "publish"]);
    assert.deepEqual(note.panels.map((panel) => panel.id), ["notes.editor", "note-extras.share", "notes.preview"]);
    registry.registerPanelComponents({ "notes.editor": "editor-v1", "note-extras.share": "share" });
    registry.registerPanelComponents({ "notes.editor": "editor-v2" });
    assert.deepEqual(
      registry.resolvePanels("note").map(({ panel, component }) => [panel.id, component]),
      [
        ["notes.editor", "editor-v2"],
        ["note-extras.share", "share"],
        ["notes.preview", undefined],
      ],
    );
    assert.throws(() => registry.registerPanelComponents({ "notes.missing": "x" }), /notes\.missing is not registered/);
  });

  test("refuses malformed and conflicting plugins, and a refused plugin changes nothing", () => {
    const cases: [string, PluginDefinition, RegExp][] = [
      ["bad id", { ...notePlugin(), id: "Notes" }, /lowercase/],
      ["unknown key", { ...notePlugin(), extra: true } as PluginDefinition, /extra/],
      ["panel outside the plugin namespace", notePlugin({ panels: [{ id: "other.editor", contentType: "note", title: "Editor" }] }), /must be named notes\.<name>/],
      ["panel for an unregistered content type", notePlugin({ panels: [{ id: "notes.editor", contentType: "memo", title: "Editor" }] }), /content type memo/],
      ["step for an unregistered content type", notePlugin({ steps: [{ id: "write", contentType: "memo", number: 1, title: "Write" }] }), /content type memo/],
      ["step in another type's panel", notePlugin({ steps: [{ id: "write", contentType: "note", number: 1, title: "Write", panel: "notes.nowhere" }] }), /not a panel of note/],
      ["duplicate step", notePlugin({ steps: [{ id: "write", contentType: "note", number: 1, title: "Write" }, { id: "write", contentType: "note", number: 2, title: "Again" }] }), /registered twice/],
      ["default panel not its own", notePlugin({ contentTypes: [{ ...notePlugin().contentTypes![0], defaultPanel: "notes.gone" }] }), /opens on notes\.gone/],
      ["invalid recipe", notePlugin({ recipes: [{ id: "x", kind: "mock" } as never] }), /recipes/],
      [
        "mode with a step the content type lacks",
        notePlugin({ contentTypes: [{ ...notePlugin().contentTypes![0], modes: [{ id: "quick", label: "Quick note", description: "One line.", panel: "notes.editor", steps: ["write", "publish"] }] }] }),
        /mode quick of note names step publish/,
      ],
      [
        "mode opening on a missing panel",
        notePlugin({ contentTypes: [{ ...notePlugin().contentTypes![0], modes: [{ id: "quick", label: "Quick note", description: "One line.", panel: "notes.gone", steps: ["write"] }] }] }),
        /mode quick of note opens on notes\.gone/,
      ],
      [
        "two modes with one id",
        notePlugin({
          contentTypes: [
            {
              ...notePlugin().contentTypes![0],
              modes: [
                { id: "quick", label: "Quick note", description: "One line.", panel: "notes.editor", steps: ["write"] },
                { id: "quick", label: "Again", description: "One line.", panel: "notes.editor", steps: ["write"] },
              ],
            },
          ],
        }),
        /two modes named quick/,
      ],
    ];
    for (const [label, definition, error] of cases) {
      const registry = createPluginRegistry();
      assert.throws(() => registry.registerPlugin(definition), error, label);
      assert.deepEqual(registry.plugins(), [], `${label}: nothing registered`);
      assert.deepEqual(registry.contentTypes(), [], `${label}: no content types`);
    }

    const registry = createPluginRegistry();
    registry.registerPlugin(notePlugin());
    assert.throws(() => registry.registerPlugin(notePlugin()), /already registered/);
    assert.throws(() => registry.registerPlugin({ ...notePlugin(), id: "notes-two", panels: [], steps: [] }), /content type note is registered twice/);
    assert.equal(registry.plugins().length, 1);
  });

  test("each prompt style and spec kind has one renderer owner", () => {
    const registry = createPluginRegistry();
    registry.registerPlugin(starterRecipesPlugin);
    assert.throws(
      () => registry.registerPlugin({ id: "krea-faces", label: "Krea faces", renderers: [{ promptStyle: "krea", render: { face: () => "a face" } }] }),
      /krea renderer for face specs is already registered/,
    );
    registry.registerPlugin({ id: "krea-bodies", label: "Krea bodies", renderers: [{ promptStyle: "krea", render: { body: () => "a krea body prompt" } }] });
    const table = registry.renderers();
    assert.ok(table.krea?.render.face, "the starter face renderer stays");
    const body = renderSpecs().body;
    assert.deepEqual(renderPrompt(body, styleRecipe("krea", "text_to_image"), table), { ok: true, prompt: "a krea body prompt", style: "krea" });
    assert.equal(renderPrompt(body, styleRecipe("krea", "text_to_image")).style, "standard", "without the registry's table, krea bodies use the house prompt");
  });

  test("the server registry renders every snapshot case exactly as the starter renderers do", () => {
    const table = serverPlugins.renderers();
    assert.deepEqual(Object.keys(table).sort(), STARTER_RENDERERS.map((entry) => entry.promptStyle).sort());
    const specs = renderSpecs();
    const styles: PromptStyle[] = ["standard", "krea", "gemini-image", "gpt-image"];
    for (const style of styles) {
      for (const name of IMAGE_CASES) assert.deepEqual(renderPrompt(specs[name], styleRecipe(style), table), renderPrompt(specs[name], styleRecipe(style)), `${style} ${name}`);
    }
    for (const name of CLIP_CASES) {
      const recipe = styleRecipe("minimax-h3", "image_to_video");
      assert.deepEqual(renderPrompt(specs[name], recipe, table), renderPrompt(specs[name], recipe), `minimax-h3 ${name}`);
    }
    assert.deepEqual(serverPlugins.recipes(), []);
  });
});

describe("UGC Ad as a registered content type", () => {
  test("is the first installed content type, made in UGC Creator, with the six workspace panels and the Quick Ad mode", () => {
    assert.deepEqual(appChoices()[0], { id: "ugc-creator", label: "UGC Creator", contentTypes: ["ad"], modes: [{ id: "quick", label: "Quick Ad", description: QUICK_AD_MODE.description, panel: UGC_AD_PANELS.quick }] });
    assert.equal(appLabel("ugc-creator"), "UGC Creator");
    const ad = appPlugins.contentTypeForApp("ugc-creator");
    assert.ok(ad);
    assert.equal(ad.id, "ad");
    assert.equal(ad.pieceType, "ad");
    assert.equal(ad.defaultPanel, UGC_AD_PANELS.documents);
    assert.deepEqual(ad.panels.map((panel) => panel.title), ["Documents", "Script", "Shots", "Assets", "Export", "Quick Ad"]);
    assert.deepEqual(
      ad.modes.map((mode) => [mode.id, mode.label, mode.panel, mode.steps]),
      [["quick", "Quick Ad", UGC_AD_PANELS.quick, ["quick", "stills", "clips", "assemble"]]],
    );
    assert.deepEqual(serverPlugins.contentType("ad"), ad, "the server and the browser read the same declaration");
  });

  test("its steps run brief to next piece and name only roster tools", () => {
    const ad = appPlugins.contentType("ad")!;
    assert.deepEqual(
      ad.steps.map((step) => step.id),
      ["brief", "quick", "character", "face", "body", "sheet", "product", "script", "shots", "stills", "clips", "voice", "assemble", "next"],
    );
    const roster = new Set([...TOOLS, ...INTERNAL_TOOLS].map((tool) => tool.name));
    for (const step of ad.steps) {
      for (const tool of step.tools) assert.ok(roster.has(tool), `${step.id} names ${tool}, which is not a tool`);
      assert.ok(step.panel && ad.panels.some((panel) => panel.id === step.panel), `${step.id} shows in one of the Ad's panels`);
    }
    assert.equal(ugcAdPlugin.steps.length, UGC_AD_STEPS.length);
  });

  test("the creative director's stages take their numbers and titles from the plugin", () => {
    for (const step of UGC_AD_STEPS) assert.deepEqual(stepOf(step.id), { id: step.id, step: step.number, title: step.title });
  });
});
