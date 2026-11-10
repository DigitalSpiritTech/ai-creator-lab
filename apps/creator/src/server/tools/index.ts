/**
 * The domain tool registry. The agent loop and the MCP server read this one list: the 34 core
 * roster tools, then the tools content plugins register (named with their plugin's id as a prefix,
 * `<plugin_id>_<action>`), each offered to the assistant only in projects of its own content type.
 * @packageDocumentation
 */
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import { type ServiceFailure, toFailure } from "@creator-lab/core/domain/failure";
import type { PluginRegistry } from "@creator-lab/core/registry";
import { listDocumentVersions, restoreDocumentVersion } from "@/server/tools/documents";
import { approve, archiveAssetTool, deleteAssetEverywhereTool, listAssets } from "@/server/tools/assets";
import {
  assembleAd,
  composeStill,
  generateBodyReference,
  generateClip,
  generateFaceCandidates,
  generateProductImages,
  generateReferenceSheet,
  listRecipes,
  proposeCandidates,
  refineStill,
  submitProposal,
} from "@/server/tools/generation";
import {
  archiveLibraryItem,
  createSetTool,
  linkLibraryItem,
  saveCharacterBible,
  saveProduct,
  selectReference,
  unlinkLibraryItem,
} from "@/server/tools/library";
import { recipeOptions, regenerateWith, rerenderProposal, setRecipePreferenceTool } from "@/server/tools/overrides";
import { getProjectState, saveBriefTool } from "@/server/tools/project";
import { startQuickAd } from "@/server/tools/quick-ad";
import { type Tool, type ToolContext, toJsonSchemaTools } from "@/server/tools/registry";
import { planShots, resetShots, saveScript, setCutOrder } from "@/server/tools/script";
import { extractVoiceSampleTool, generateVoiceOver } from "@/server/tools/voice";
import { type PortScope, manifestOf, pluginTool, scopeOf } from "@/server/tools/plugins";
import { serverPlugins } from "@/plugins/server";

export { createToolContext, type GenerationContext, type Tool, type ToolContext } from "@/server/tools/registry";
export { createGenerationContext } from "@/server/tools/generation-context";

/**
 * Every tool the assistant is offered, in roster order: get_project_state, save_brief,
 * save_character_bible, propose_candidates, select_reference, generate_reference_sheet,
 * save_product, save_script, plan_shots, compose_still, refine_still, generate_clip, extract_voice_sample, generate_voice_over, approve,
 * archive_asset, delete_asset_everywhere, assemble_ad, list_assets, list_recipes, then the Library
 * tools link_library_item, unlink_library_item, archive_library_item, create_set, set_cut_order, reset_shots,
 * the document tools list_document_versions and restore_document_version, the model override
 * tools set_recipe_preference and regenerate_with, and start_quick_ad (the Quick Ad, v0.2 F11).
 */
export const TOOLS: readonly Tool[] = [
  getProjectState,
  saveBriefTool,
  saveCharacterBible,
  proposeCandidates,
  selectReference,
  generateFaceCandidates,
  generateBodyReference,
  generateReferenceSheet,
  saveProduct,
  generateProductImages,
  saveScript,
  planShots,
  composeStill,
  refineStill,
  generateClip,
  extractVoiceSampleTool,
  generateVoiceOver,
  approve,
  archiveAssetTool,
  deleteAssetEverywhereTool,
  assembleAd,
  listAssets,
  listRecipes,
  linkLibraryItem,
  unlinkLibraryItem,
  archiveLibraryItem,
  createSetTool,
  setCutOrder,
  resetShots,
  listDocumentVersions,
  restoreDocumentVersion,
  setRecipePreferenceTool,
  regenerateWith,
  startQuickAd,
];

/**
 * Tools the UI calls but the assistant is not offered: the spending gate, and the proposal card's
 * recipe selector (its options and the re-render for another recipe), each behind its own route.
 */
export const INTERNAL_TOOLS: readonly Tool[] = [submitProposal, rerenderProposal, recipeOptions];

/**
 * The roster the assistant is offered: everything except permanent deletion, which stays a
 * person's click on the Archive page. A prompt injection in project text can then at worst
 * archive something restorable.
 */
export const AGENT_TOOLS: readonly Tool[] = TOOLS.filter((tool) => tool.name !== "delete_asset_everywhere");

/** The tools installed content plugins register, in registration order. */
export const PLUGIN_TOOLS: readonly Tool[] = serverPlugins.tools().map((tool) => pluginTool(tool, () => pluginScope(tool.plugin), callTool));

/**
 * What a plugin's port may reach: its own piece types, its own Apps' projects, and the roster tools
 * the assistant is offered for its content types.
 */
export function pluginScope(pluginId: string, registry: Pick<PluginRegistry, "plugins" | "contentType" | "tools"> = serverPlugins): PortScope {
  return scopeOf(manifestOf(registry, pluginId), (contentTypeId) => agentToolsFor(contentTypeId, registry).map((tool) => tool.name));
}

/** Every tool a route, the assistant, or an MCP client may name: the core roster plus plugin tools. */
export const ROSTER_TOOLS: readonly Tool[] = [...TOOLS, ...PLUGIN_TOOLS];

/**
 * Roster tools every content type's assistant is offered whatever its steps name: reading the
 * project, generic generation and its gate-bound proposals, approval, the Archive, the Library, the
 * document history, and recipe choice. The rest of the roster is offered where a step names it.
 */
export const WORKSPACE_TOOL_NAMES: readonly string[] = [
  "get_project_state",
  "save_brief",
  "propose_candidates",
  "refine_still",
  "approve",
  "archive_asset",
  "list_assets",
  "list_recipes",
  "link_library_item",
  "unlink_library_item",
  "archive_library_item",
  "create_set",
  "list_document_versions",
  "restore_document_version",
  "set_recipe_preference",
  "regenerate_with",
];

/**
 * The tools the assistant is offered in a project of `contentTypeId`: the workspace tools, the
 * roster tools its steps name, and its plugin's own tools, in roster order. For the Ad that is all
 * of `AGENT_TOOLS`. An unknown content type gets `AGENT_TOOLS`.
 */
export function agentToolsFor(contentTypeId: string | undefined, registry: Pick<PluginRegistry, "contentType" | "tools"> = serverPlugins): Tool[] {
  const type = contentTypeId ? registry.contentType(contentTypeId) : undefined;
  if (!type) return [...AGENT_TOOLS];
  const named = new Set([...WORKSPACE_TOOL_NAMES, ...type.steps.flatMap((step) => step.tools)]);
  const own = new Set(registry.tools(type.id).map((tool) => tool.name));
  return [...AGENT_TOOLS.filter((tool) => named.has(tool.name)), ...PLUGIN_TOOLS.filter((tool) => own.has(tool.name))];
}

function indexTools(tools: readonly Tool[]): Map<string, Tool> {
  const index = new Map<string, Tool>();
  for (const tool of tools) {
    if (index.has(tool.name)) throw new Error(`Tool ${tool.name} is registered twice.`);
    index.set(tool.name, tool);
  }
  return index;
}

const TOOL_INDEX = indexTools([...TOOLS, ...INTERNAL_TOOLS, ...PLUGIN_TOOLS]);

export function getTool(name: string): Tool | undefined {
  return TOOL_INDEX.get(name);
}

/** Whether `name` is a roster tool a route may run (core or plugin; never an internal tool). */
export function isRosterTool(name: string): boolean {
  return ROSTER_TOOLS.some((tool) => tool.name === name);
}

export type ToolResult = { ok: true; output: unknown } | { ok: false; failure: ServiceFailure };

/**
 * Validates input, runs the tool, and validates its output. Never throws: unknown tools,
 * invalid input, and expected failures come back as `{ ok: false, failure }`.
 */
export async function callTool(context: ToolContext, name: string, input: unknown): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) return { ok: false, failure: { code: "invalid", message: `Unknown tool ${name}.` } };
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return { ok: false, failure: { code: "invalid", message: z.prettifyError(parsed.error) } };
  try {
    return { ok: true, output: tool.output.parse(await tool.run(context, parsed.data)) };
  } catch (error) {
    return { ok: false, failure: toFailure(error) };
  }
}

/** The `tools` array for the Anthropic Messages API: the roster, without internal tools. */
export function toolsToJsonSchema(tools: readonly Tool[] = TOOLS): AnthropicTool[] {
  return toJsonSchemaTools(tools);
}
