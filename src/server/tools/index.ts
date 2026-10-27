/**
 * The domain tool registry. The agent loop and the MCP server read this one list.
 * @packageDocumentation
 */
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import { type ServiceFailure, toFailure } from "@/lib/domain/failure";
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
import { getProjectState, saveBriefTool } from "@/server/tools/project";
import { type Tool, type ToolContext, toJsonSchemaTools } from "@/server/tools/registry";
import { planShots, resetShots, saveScript, setCutOrder } from "@/server/tools/script";

export { createToolContext, type GenerationContext, type Tool, type ToolContext } from "@/server/tools/registry";
export { createGenerationContext } from "@/server/tools/generation-context";

/**
 * Every tool the assistant is offered, in roster order: get_project_state, save_brief,
 * save_character_bible, propose_candidates, select_reference, generate_reference_sheet,
 * save_product, save_script, plan_shots, compose_still, refine_still, generate_clip, approve,
 * archive_asset, delete_asset_everywhere, assemble_ad, list_assets, list_recipes, then the Library
 * tools link_library_item, unlink_library_item, archive_library_item, create_set, set_cut_order, and reset_shots.
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
];

/** Tools the UI calls but the assistant is not offered (the spending gate). */
export const INTERNAL_TOOLS: readonly Tool[] = [submitProposal];

const TOOL_INDEX = new Map([...TOOLS, ...INTERNAL_TOOLS].map((tool) => [tool.name, tool]));

export function getTool(name: string): Tool | undefined {
  return TOOL_INDEX.get(name);
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
