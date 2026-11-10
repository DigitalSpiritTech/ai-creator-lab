/**
 * The data half of a plugin: content types, their steps, their UI panels (by id), and recipes.
 * Everything here is plain data validated with Zod, so the same declaration can be read on the
 * server, sent to the browser, and listed over MCP. Functions (prompt renderers) and React
 * components (panel implementations) are registered beside it, never inside it.
 * @packageDocumentation
 */
import { z } from "zod";
import { RecipeSchema } from "../catalog/recipes";

/** A plugin or content type id: lowercase, starts with a letter, hyphens allowed. */
export const PluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use lowercase letters, digits, and hyphens, starting with a letter.");

/** A panel id, namespaced by its plugin (`ugc-ad.documents`), so two plugins never collide. */
export const PanelIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$/, "Panel ids are `<plugin id>.<name>`.");

/** A domain tool name as the tools registry knows it (`save_brief`). */
export const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const label = (max: number) => z.string().trim().min(1).max(max);

/** The App a content type is made in (docs/PRODUCT.md: "App: a guided way of working"). */
export const AppRefSchema = z
  .object({
    /** The project's `appId`. */
    id: PluginIdSchema,
    label: label(40),
  })
  .strict();
export type AppRef = z.infer<typeof AppRefSchema>;

/**
 * A mode of a content type: another way through the same content type, with its own steps (a
 * subset of the content type's, in order) and the panel it opens on. The Ad's Quick Ad is one: a
 * two-line brief, one frame, one clip, the export. The Projects page offers each mode as its own
 * start button; the content type itself is the full flow.
 */
export const ContentModeSchema = z
  .object({
    id: PluginIdSchema,
    /** "Quick Ad". */
    label: label(40),
    description: label(400),
    /** The panel a project started in this mode opens on. */
    panel: PanelIdSchema,
    /** The step ids this mode moves through, in order; each is a step of the content type. */
    steps: z.array(PluginIdSchema).min(1).max(24),
  })
  .strict();
export type ContentMode = z.infer<typeof ContentModeSchema>;

/**
 * A content type: the kind of content piece a project makes (the Ad), the App it belongs to, and
 * the panel the workspace opens on. Its steps and panels are registered separately (below) and
 * reference it by id, so another plugin can add a step or a panel to an existing content type.
 */
export const ContentTypeSchema = z
  .object({
    id: PluginIdSchema,
    /** "Ad". */
    label: label(40),
    app: AppRefSchema,
    description: label(400),
    /** The content piece `type` stored for this content type (`ad`). */
    pieceType: PluginIdSchema,
    /** The panel the project workspace shows first. */
    defaultPanel: PanelIdSchema,
    /** Other ways through this content type (the Quick Ad), besides the full flow. */
    modes: z.array(ContentModeSchema).max(8).default([]),
  })
  .strict();
export type ContentType = z.infer<typeof ContentTypeSchema>;

/**
 * One step of a content type's flow: what the creator does there, the domain tools that do it,
 * and the panel where its result shows up. `number` is the step in the flow the product docs
 * describe; two steps may share one (stills and their shots are both step 10 of the Ad).
 */
export const StepSchema = z
  .object({
    id: PluginIdSchema,
    contentType: PluginIdSchema,
    number: z.number().int().positive().max(99),
    title: label(60),
    tools: z.array(ToolNameSchema).max(24).default([]),
    panel: PanelIdSchema.optional(),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;
export type StepInput = z.input<typeof StepSchema>;

/**
 * A workspace panel (a tab beside the chat). The declaration is data; the React component that
 * draws it is registered on the client under the same id (see `registerPanelComponents`).
 */
export const PanelSchema = z
  .object({
    id: PanelIdSchema,
    contentType: PluginIdSchema,
    /** The tab label. */
    title: label(40),
    /** Tabs sort by `order`, then by registration. */
    order: z.number().int().min(0).max(1000).default(100),
  })
  .strict();
export type Panel = z.infer<typeof PanelSchema>;
export type PanelInput = z.input<typeof PanelSchema>;

/** The data a plugin registers. Prompt renderers ride beside it in `PluginDefinition`. */
export const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    label: label(60),
    contentTypes: z.array(ContentTypeSchema).max(16).default([]),
    steps: z.array(StepSchema).max(64).default([]),
    panels: z.array(PanelSchema).max(32).default([]),
    /** Extra recipes, listed after the starter catalog and the Router models switched on in Settings. */
    recipes: z.array(RecipeSchema).max(200).default([]),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginManifestInput = z.input<typeof PluginManifestSchema>;

/** A content type with its steps and panels resolved and sorted: what the shell renders. */
export interface ResolvedContentType extends ContentType {
  plugin: string;
  steps: Step[];
  panels: Panel[];
}
