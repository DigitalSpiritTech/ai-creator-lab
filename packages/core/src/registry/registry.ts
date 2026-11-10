/**
 * The plugin registry: content types, steps, recipes, prompt renderers, UI panels, domain tools,
 * piece body schemas, and assistants, all added through one `registerPlugin` call per plugin. The app builds one registry from its installed
 * plugins; the project shell, the tools layer, and the recipe catalog read from it, so a new
 * content type needs a plugin package and an entry in the installed list, not a change to them.
 *
 * Registration is strict and order-dependent on purpose: ids are unique across the registry, and a
 * step or panel may only name a content type that is already registered (by this plugin or an
 * earlier one). Mistakes fail at startup with a message, never as a missing tab later.
 *
 * Pure: no I/O and no React. Panel components are typed by the registry's `C` parameter, which
 * the app sets to its React component type.
 * @packageDocumentation
 */
import { z } from "zod";
import type { Recipe } from "../catalog/recipes";
import type { PromptStyle } from "../catalog/prompt-style";
import type { ShotSpec, ShotSpecKind } from "../domain/shot-spec";
import type { ContentAssistantDefinition, PieceTypeDefinition, PluginToolDefinition } from "./contributions";
import {
  type ContentType,
  type Panel,
  type PluginManifest,
  type PluginManifestInput,
  PluginManifestSchema,
  type ResolvedContentType,
  type Step,
  ToolNameSchema,
} from "./schema";

/** Renders one kind of shot spec as a prompt, or explains why it cannot. Pure; never throws on content. */
export type ShotRenderer<K extends ShotSpecKind = ShotSpecKind> = (spec: Extract<ShotSpec, { kind: K }>) => string | { error: string };
export type ShotRenderers = { [K in ShotSpecKind]?: ShotRenderer<K> };

/** Prompt renderers for one prompt style (`promptStyle` on a recipe, or inferred from it). */
export interface PromptRendererContribution {
  promptStyle: PromptStyle;
  render: ShotRenderers;
  /** The longest prompt these renderers may return; the house limit when absent. */
  limit?: number;
}

/** Every registered renderer, by style. Each (style, kind) pair has exactly one owner. */
export type RendererTable = { [S in PromptStyle]?: { render: ShotRenderers; limit?: number } };

/**
 * What a plugin registers: the Zod-checked manifest plus its server contributions (prompt
 * renderers, domain tools, piece body schemas, and assistants). The browser registers the manifest
 * alone; the server registers the same plugin with its contributions.
 */
export interface PluginDefinition extends PluginManifestInput {
  renderers?: PromptRendererContribution[];
  tools?: PluginToolDefinition[];
  pieces?: PieceTypeDefinition[];
  assistants?: ContentAssistantDefinition[];
}

/** A registered plugin tool and the plugin that added it. */
export interface RegisteredTool extends PluginToolDefinition {
  plugin: string;
}

/** The prefix a plugin's tool names start with: its id in snake case (`memo_pad_` for `memo-pad`). */
export function toolPrefix(pluginId: string): string {
  return `${pluginId.replaceAll("-", "_")}_`;
}

/** Types a plugin definition without registering it (plugin packages export one of these). */
export function definePlugin<const T extends PluginDefinition>(definition: T): T {
  return definition;
}

/** A panel ready to draw: its declaration and the component registered for it, if any. */
export interface ResolvedPanel<C> {
  panel: Panel;
  component: C | undefined;
}

export interface PluginRegistry<C = unknown> {
  /** Validates and adds a plugin. Throws on malformed input, duplicate ids, or dangling references. */
  registerPlugin(definition: PluginDefinition): PluginManifest;
  /**
   * Client side: the components that draw a plugin's panels, keyed by panel id. Every id must be a
   * registered panel. Registering a panel again replaces its component (a hot reload re-runs the
   * module that registers them).
   */
  registerPanelComponents(components: Readonly<Record<string, C>>): void;
  plugins(): PluginManifest[];
  /** Every content type in registration order, with its steps and panels sorted. */
  contentTypes(): ResolvedContentType[];
  contentType(id: string): ResolvedContentType | undefined;
  /** The first content type made in an App (a project's `appId`). */
  contentTypeForApp(appId: string): ResolvedContentType | undefined;
  step(contentTypeId: string, stepId: string): Step | undefined;
  /** A content type's panels, each with its component (undefined when none is registered here). */
  resolvePanels(contentTypeId: string): ResolvedPanel<C>[];
  panelComponent(panelId: string): C | undefined;
  /** Recipes from plugins, in registration order. */
  recipes(): Recipe[];
  renderers(): RendererTable;
  /** Plugin tools in registration order; with a content type, only its own. */
  tools(contentTypeId?: string): RegisteredTool[];
  /** The body schema registered for a piece type. */
  pieceType(pieceType: string): (PieceTypeDefinition & { plugin: string }) | undefined;
  /** The assistant registered for a content type, if any. */
  assistant(contentTypeId: string): ContentAssistantDefinition | undefined;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

function sortSteps(steps: readonly Step[]): Step[] {
  return steps.map((step, index) => ({ step, index })).sort((a, b) => a.step.number - b.step.number || a.index - b.index).map(({ step }) => step);
}

function sortPanels(panels: readonly Panel[]): Panel[] {
  return panels.map((panel, index) => ({ panel, index })).sort((a, b) => a.panel.order - b.panel.order || a.index - b.index).map(({ panel }) => panel);
}

/** A new, empty registry. The app keeps one (`apps/creator/src/plugins`); tests make their own. */
export function createPluginRegistry<C = unknown>(): PluginRegistry<C> {
  const manifests: PluginManifest[] = [];
  const contentTypes = new Map<string, { plugin: string; type: ContentType }>();
  const appContentTypes = new Map<string, string>();
  const steps: Step[] = [];
  const panels = new Map<string, Panel>();
  const components = new Map<string, C>();
  const recipes: Recipe[] = [];
  const renderers: RendererTable = {};
  const tools: RegisteredTool[] = [];
  const pieceTypes = new Map<string, PieceTypeDefinition & { plugin: string }>();
  const assistants = new Map<string, ContentAssistantDefinition>();

  function fail(plugin: string, message: string): never {
    throw new Error(`Plugin ${plugin}: ${message}`);
  }

  function resolve(id: string): ResolvedContentType | undefined {
    const entry = contentTypes.get(id);
    if (!entry) return undefined;
    return {
      ...entry.type,
      plugin: entry.plugin,
      steps: sortSteps(steps.filter((step) => step.contentType === id)),
      panels: sortPanels([...panels.values()].filter((panel) => panel.contentType === id)),
    };
  }

  return {
    registerPlugin(definition) {
      const { renderers: contributions = [], tools: toolDefinitions = [], pieces = [], assistants: assistantDefinitions = [], ...data } = definition;
      const parsed = PluginManifestSchema.safeParse(data);
      if (!parsed.success) fail(String(definition.id), z.prettifyError(parsed.error));
      const manifest = parsed.data;
      const { id } = manifest;
      if (manifests.some((existing) => existing.id === id)) fail(id, "is already registered.");

      const typeIds = manifest.contentTypes.map((type) => type.id);
      for (const repeated of duplicates([...contentTypes.keys(), ...typeIds])) fail(id, `content type ${repeated} is registered twice.`);
      const known = new Set([...contentTypes.keys(), ...typeIds]);

      const panelIds = manifest.panels.map((panel) => panel.id);
      for (const repeated of duplicates([...panels.keys(), ...panelIds])) fail(id, `panel ${repeated} is registered twice.`);
      for (const panel of manifest.panels) {
        if (!panel.id.startsWith(`${id}.`)) fail(id, `panel ${panel.id} must be named ${id}.<name>.`);
        if (!known.has(panel.contentType)) fail(id, `panel ${panel.id} names content type ${panel.contentType}, which is not registered.`);
      }
      const allPanels = new Map([...panels, ...manifest.panels.map((panel) => [panel.id, panel] as const)]);

      for (const step of manifest.steps) {
        if (!known.has(step.contentType)) fail(id, `step ${step.id} names content type ${step.contentType}, which is not registered.`);
        if (steps.some((other) => other.contentType === step.contentType && other.id === step.id)) fail(id, `step ${step.id} is already registered for ${step.contentType}.`);
        if (step.panel && allPanels.get(step.panel)?.contentType !== step.contentType) fail(id, `step ${step.id} shows in panel ${step.panel}, which is not a panel of ${step.contentType}.`);
      }
      for (const repeated of duplicates(manifest.steps.map((step) => `${step.contentType}/${step.id}`))) fail(id, `step ${repeated} is registered twice.`);

      for (const type of manifest.contentTypes) {
        const own = allPanels.get(type.defaultPanel);
        if (!own || own.contentType !== type.id) fail(id, `content type ${type.id} opens on ${type.defaultPanel}, which is not one of its panels.`);
        for (const repeated of duplicates(type.modes.map((mode) => mode.id))) fail(id, `content type ${type.id} has two modes named ${repeated}.`);
        const stepIds = new Set(manifest.steps.filter((step) => step.contentType === type.id).map((step) => step.id));
        for (const mode of type.modes) {
          if (allPanels.get(mode.panel)?.contentType !== type.id) fail(id, `mode ${mode.id} of ${type.id} opens on ${mode.panel}, which is not one of its panels.`);
          for (const stepId of mode.steps) {
            if (!stepIds.has(stepId)) fail(id, `mode ${mode.id} of ${type.id} names step ${stepId}, which is not one of its steps.`);
          }
        }
      }

      const recipeIds = new Set(recipes.map((recipe) => recipe.id));
      for (const recipe of manifest.recipes) {
        if (recipeIds.has(recipe.id)) fail(id, `recipe ${recipe.id} is registered twice.`);
        recipeIds.add(recipe.id);
      }

      for (const contribution of contributions) {
        const existing = renderers[contribution.promptStyle];
        for (const kind of Object.keys(contribution.render)) {
          if (existing?.render[kind as ShotSpecKind]) fail(id, `the ${contribution.promptStyle} renderer for ${kind} specs is already registered.`);
        }
        if (existing?.limit !== undefined && contribution.limit !== undefined && existing.limit !== contribution.limit) {
          fail(id, `the ${contribution.promptStyle} prompt limit is already ${existing.limit}.`);
        }
      }

      const prefix = toolPrefix(id);
      const ownTypes = new Set(typeIds);
      for (const tool of toolDefinitions) {
        if (!ToolNameSchema.safeParse(tool.name).success || !tool.name.startsWith(prefix) || tool.name === prefix) {
          fail(id, `tool ${tool.name} must be named ${prefix}<action> in lowercase snake case.`);
        }
        if (!ownTypes.has(tool.contentType)) fail(id, `tool ${tool.name} names content type ${tool.contentType}, which this plugin does not register.`);
        if (tool.input.def.type !== "object") fail(id, `tool ${tool.name} must take an object input.`);
      }
      for (const repeated of duplicates([...tools.map((tool) => tool.name), ...toolDefinitions.map((tool) => tool.name)])) fail(id, `tool ${repeated} is registered twice.`);
      const ownPieceTypes = new Set(manifest.contentTypes.map((type) => type.pieceType));
      for (const piece of pieces) {
        if (!ownPieceTypes.has(piece.pieceType)) fail(id, `piece type ${piece.pieceType} is not the piece type of one of this plugin's content types.`);
      }
      for (const repeated of duplicates([...pieceTypes.keys(), ...pieces.map((piece) => piece.pieceType)])) fail(id, `piece type ${repeated} is registered twice.`);
      for (const assistant of assistantDefinitions) {
        if (!ownTypes.has(assistant.contentType)) fail(id, `the assistant for ${assistant.contentType} must be for one of this plugin's content types.`);
        if (!assistant.systemPrompt.trim()) fail(id, `the assistant for ${assistant.contentType} needs a system prompt.`);
      }
      for (const repeated of duplicates(assistantDefinitions.map((assistant) => assistant.contentType))) fail(id, `content type ${repeated} has two assistants.`);

      // Everything checked: commit.
      manifests.push(manifest);
      for (const type of manifest.contentTypes) {
        contentTypes.set(type.id, { plugin: id, type });
        if (!appContentTypes.has(type.app.id)) appContentTypes.set(type.app.id, type.id);
      }
      for (const panel of manifest.panels) panels.set(panel.id, panel);
      steps.push(...manifest.steps);
      recipes.push(...manifest.recipes);
      tools.push(...toolDefinitions.map((tool) => ({ ...tool, plugin: id })));
      for (const piece of pieces) pieceTypes.set(piece.pieceType, { ...piece, plugin: id });
      for (const assistant of assistantDefinitions) assistants.set(assistant.contentType, assistant);
      for (const contribution of contributions) {
        const existing = renderers[contribution.promptStyle];
        renderers[contribution.promptStyle] = {
          render: { ...existing?.render, ...contribution.render },
          limit: existing?.limit ?? contribution.limit,
        };
      }
      return manifest;
    },

    registerPanelComponents(entries) {
      for (const [panelId, component] of Object.entries(entries)) {
        if (!panels.has(panelId)) throw new Error(`Panel ${panelId} is not registered; register its plugin first.`);
        components.set(panelId, component);
      }
    },

    plugins: () => [...manifests],
    contentTypes: () => [...contentTypes.keys()].map((id) => resolve(id)!),
    contentType: resolve,
    contentTypeForApp(appId) {
      const id = appContentTypes.get(appId);
      return id ? resolve(id) : undefined;
    },
    step: (contentTypeId, stepId) => steps.find((step) => step.contentType === contentTypeId && step.id === stepId),
    resolvePanels: (contentTypeId) => (resolve(contentTypeId)?.panels ?? []).map((panel) => ({ panel, component: components.get(panel.id) })),
    panelComponent: (panelId) => components.get(panelId),
    recipes: () => [...recipes],
    renderers: () => Object.fromEntries(Object.entries(renderers).map(([style, entry]) => [style, { ...entry, render: { ...entry.render } }])) as RendererTable,
    tools: (contentTypeId) => tools.filter((tool) => contentTypeId === undefined || tool.contentType === contentTypeId),
    pieceType: (pieceType) => pieceTypes.get(pieceType),
    assistant: (contentTypeId) => assistants.get(contentTypeId),
  };
}
