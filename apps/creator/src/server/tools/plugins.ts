/**
 * Plugin tools in the tools layer: each tool a content plugin registers becomes a roster `Tool`
 * whose `run` gets a `PluginToolPort` over this context. The port is scoped to its plugin:
 *
 * - Projects: only the request owner's projects made in one of the plugin's own Apps.
 * - Pieces: only the plugin's own piece types, in those projects, for that owner.
 * - Roster calls: only the tools the assistant is offered for the plugin's content types
 *   (`agentToolsFor`), never the spending gate or permanent deletion, and only on records in scope:
 *   every `projectId`, `contentId`, document `subjectId`, generation `target`, `assetId`,
 *   Library `itemId`, and `scriptId` in the input is checked before the call, and a proposal that
 *   comes back must be for a project in scope and land in one of the plugin's pieces (or nowhere).
 *
 * So a plugin tool can propose a generation for its own pieces and nothing more.
 * @packageDocumentation
 */
import { ServiceError, fail } from "@creator-lab/core/domain/failure";
import { GenerationProposalSchema } from "@creator-lab/core/domain/job";
import { type PluginPiece, PluginPieceSchema } from "@creator-lab/core/domain/piece";
import type { Project } from "@creator-lab/core/domain/project";
import type { PluginManifest, PluginRegistry, PluginToolPort, RegisteredTool } from "@creator-lab/core/registry";
import { insertPiece, savePiece } from "@/server/tools/pieces";
import { type Tool, type ToolContext, ownerOf } from "@/server/tools/registry";
import type { ToolResult } from "@/server/tools";

/** Runs a roster tool by name; the tools index passes its own `callTool`. */
export type ToolDispatch = (context: ToolContext, name: string, input: unknown) => Promise<ToolResult>;

/** Tools a plugin may never call through its port: the spending gate, the card's routes, and permanent deletion. */
export const PORT_REFUSED_TOOLS: ReadonlySet<string> = new Set(["submit_proposal", "rerender_proposal", "recipe_options", "delete_asset_everywhere"]);

/** What one plugin's port may reach. */
export interface PortScope {
  /** The plugin's own piece types. */
  pieceTypes: ReadonlySet<string>;
  /** The Apps of the plugin's content types: only their projects are in scope. */
  appIds: ReadonlySet<string>;
  /** Roster tools the port may call: those offered to the assistant for the plugin's content types. */
  tools: ReadonlySet<string>;
}

/** The scope of a plugin from its manifest; `toolsFor` names the tools offered for one content type. */
export function scopeOf(manifest: Pick<PluginManifest, "contentTypes"> | undefined, toolsFor: (contentTypeId: string) => readonly string[]): PortScope {
  const types = manifest?.contentTypes ?? [];
  return {
    pieceTypes: new Set(types.map((type) => type.pieceType)),
    appIds: new Set(types.map((type) => type.app.id)),
    tools: new Set(types.flatMap((type) => toolsFor(type.id)).filter((name) => !PORT_REFUSED_TOOLS.has(name))),
  };
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** The port a plugin tool runs against, for one call. */
export function pluginPort(context: ToolContext, scope: PortScope, dispatch: ToolDispatch): PluginToolPort {
  const { store } = context;
  const ownerId = ownerOf(context);
  const missing = (what = "content piece"): never => fail("not_found", `This ${what} could not be found.`);
  const own = (piece: PluginPiece): PluginPiece => (scope.pieceTypes.has(piece.type) && piece.ownerId === ownerId ? piece : missing());
  const project = (projectId: string): Project => {
    const found = store.projects.get(projectId);
    if (!found || found.ownerId !== ownerId) return missing("project");
    if (!scope.appIds.has(found.appId)) fail("invalid", "This project was made in another App; this plugin works only in projects of its own Apps.");
    return found;
  };
  const ownPiece = (contentId: string): PluginPiece => {
    const piece = own(store.pieces.get(contentId) ?? missing());
    project(piece.projectId);
    return piece;
  };
  const asset = (assetId: string) => {
    const found = store.assets.get(assetId);
    if (!found || found.ownerId !== ownerId) return missing("asset");
    if (found.projectId !== null) project(found.projectId);
    return found;
  };
  const libraryItem = (itemId: string) => {
    const item = store.library.get(itemId);
    if (item && item.ownerId !== ownerId) missing("Library item");
  };

  /** Refuses input that names anything outside the plugin's scope. */
  function checkInput(input: Record<string, unknown>): void {
    const projectId = text(input.projectId);
    if (projectId) project(projectId);
    const contentId = text(input.contentId);
    if (contentId) ownPiece(contentId);
    const assetId = text(input.assetId);
    if (assetId) asset(assetId);
    if (Array.isArray(input.referenceAssetIds)) for (const id of input.referenceAssetIds) if (text(id)) asset(text(id)!);
    for (const key of ["itemId", "characterId", "productId"]) {
      const id = text(input[key]);
      if (id) libraryItem(id);
    }
    const scriptId = text(input.scriptId);
    if (scriptId) project((store.scripts.get(scriptId) ?? missing("script")).projectId);
    const subjectId = text(input.subjectId);
    if (subjectId) {
      const kind = text(input.kind);
      if (kind === "piece") ownPiece(subjectId);
      else if (kind === "brief") project(subjectId);
      else if (kind === "bible" || kind === "product") libraryItem(subjectId);
      else fail("invalid", `A plugin tool cannot read ${kind ?? "that"} documents.`);
    }
    const target = record(input.target);
    if (target) checkTarget(target);
  }

  function checkTarget(target: Record<string, unknown>): void {
    if (target.kind === "loose") return;
    if (target.kind === "piece" && text(target.contentId)) {
      ownPiece(text(target.contentId)!);
      return;
    }
    fail("invalid", "A plugin tool can aim generations only at its own content pieces.");
  }

  return {
    ownerId,
    author: context.author ?? "user",
    now: () => context.now(),
    newId: () => context.newId(),
    transaction: (work) => store.transaction(work),
    project,
    pieces: (projectId, type) => {
      if (!scope.pieceTypes.has(type)) fail("invalid", `This plugin does not keep ${type} content pieces.`);
      project(projectId);
      return store.pieces.listByProject(projectId, type).filter((piece) => piece.ownerId === ownerId);
    },
    piece: ownPiece,
    createPiece: (input) => {
      const piece = own(PluginPieceSchema.parse({ ...input, ownerId: input.ownerId ?? ownerId }));
      project(piece.projectId);
      return insertPiece(context, piece);
    },
    savePiece: (next) => {
      ownPiece(next.id);
      return savePiece(context, own(next));
    },
    asset: (assetId) => {
      const found = store.assets.get(assetId);
      return found && found.ownerId === ownerId ? found : undefined;
    },
    callTool: async <T>(name: string, input: Record<string, unknown>) => {
      if (PORT_REFUSED_TOOLS.has(name) || !scope.tools.has(name)) fail("invalid", `A plugin tool cannot call ${name}.`);
      checkInput(input);
      const result = await dispatch(context, name, input);
      if (!result.ok) throw new ServiceError(result.failure.code, result.failure.message);
      // A proposal built from an asset (regenerate_with, refine_still) takes that asset's
      // destination, so the result is checked as well as the input.
      const proposal = GenerationProposalSchema.safeParse(result.output);
      if (proposal.success) {
        project(proposal.data.projectId);
        checkTarget(proposal.data.target);
      }
      return result.output as T;
    },
  };
}

/**
 * A registered plugin tool as a roster tool, running against a port with its plugin's scope. The
 * scope is read on first use, since it depends on the whole roster (plugin tools included).
 */
export function pluginTool(definition: RegisteredTool, scope: () => PortScope, dispatch: ToolDispatch): Tool {
  let cached: PortScope | undefined;
  return {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    run: (context, input) => definition.run(pluginPort(context, (cached ??= scope()), dispatch), input),
  };
}

/** The manifest of the plugin that registered a tool. */
export function manifestOf(registry: Pick<PluginRegistry, "plugins">, pluginId: string): PluginManifest | undefined {
  return registry.plugins().find((plugin) => plugin.id === pluginId);
}
