/**
 * Plugin tools in the tools layer: each tool a content plugin registers becomes a roster `Tool`
 * whose `run` gets a `PluginToolPort` over this context. The port scopes the plugin to its own
 * piece types and the request's owner, checks and versions piece bodies, and lets the plugin call
 * the roster tools the assistant may call. It never reaches the spending gate (`submit_proposal`)
 * or permanent deletion, so a plugin tool can propose a generation but never run or delete one.
 * @packageDocumentation
 */
import { ServiceError, fail } from "@creator-lab/core/domain/failure";
import { type PluginPiece, PluginPieceSchema } from "@creator-lab/core/domain/piece";
import type { PluginRegistry, PluginToolPort, RegisteredTool } from "@creator-lab/core/registry";
import { insertPiece, savePiece } from "@/server/tools/pieces";
import { type Tool, type ToolContext, ownerOf } from "@/server/tools/registry";
import type { ToolResult } from "@/server/tools";

/** Runs a roster tool by name; the tools index passes its own `callTool`. */
export type ToolDispatch = (context: ToolContext, name: string, input: unknown) => Promise<ToolResult>;

/** Tools a plugin may never call through its port: the spending gate and permanent deletion. */
export const PORT_REFUSED_TOOLS: ReadonlySet<string> = new Set(["submit_proposal", "rerender_proposal", "recipe_options", "delete_asset_everywhere"]);

/** The port a plugin tool runs against, for one call. `pieceTypes` are the plugin's own piece types. */
export function pluginPort(context: ToolContext, pieceTypes: ReadonlySet<string>, dispatch: ToolDispatch): PluginToolPort {
  const { store } = context;
  const ownerId = ownerOf(context);
  const missing = (): never => fail("not_found", "This content piece could not be found.");
  const own = (piece: PluginPiece): PluginPiece => (pieceTypes.has(piece.type) && piece.ownerId === ownerId ? piece : missing());
  const project = (projectId: string) => {
    const found = store.projects.getRequired(projectId);
    return found.ownerId === ownerId ? found : fail("not_found", "This project could not be found.");
  };
  return {
    ownerId,
    author: context.author ?? "user",
    now: () => context.now(),
    newId: () => context.newId(),
    transaction: (work) => store.transaction(work),
    project,
    pieces: (projectId, type) => {
      if (!pieceTypes.has(type)) fail("invalid", `This plugin does not keep ${type} content pieces.`);
      project(projectId);
      return store.pieces.listByProject(projectId, type).filter((piece) => piece.ownerId === ownerId);
    },
    piece: (contentId) => own(store.pieces.get(contentId) ?? missing()),
    createPiece: (input) => {
      const piece = own(PluginPieceSchema.parse({ ...input, ownerId: input.ownerId ?? ownerId }));
      project(piece.projectId);
      return insertPiece(context, piece);
    },
    savePiece: (next) => {
      own(store.pieces.get(next.id) ?? missing());
      return savePiece(context, own(next));
    },
    asset: (assetId) => store.assets.get(assetId),
    callTool: async <T>(name: string, input: Record<string, unknown>) => {
      if (PORT_REFUSED_TOOLS.has(name)) fail("invalid", `A plugin tool cannot call ${name}.`);
      const result = await dispatch(context, name, input);
      if (!result.ok) throw new ServiceError(result.failure.code, result.failure.message);
      return result.output as T;
    },
  };
}

/** A registered plugin tool as a roster tool. */
export function pluginTool(definition: RegisteredTool, registry: Pick<PluginRegistry, "plugins">, dispatch: ToolDispatch): Tool {
  const manifest = registry.plugins().find((plugin) => plugin.id === definition.plugin);
  const pieceTypes = new Set(manifest?.contentTypes.map((type) => type.pieceType) ?? []);
  return {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    run: (context, input) => definition.run(pluginPort(context, pieceTypes, dispatch), input),
  };
}
