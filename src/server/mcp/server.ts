/**
 * MCP server over the domain tool registry, so Claude Code, Claude Desktop, and other MCP clients
 * drive the same flow as the in-app assistant. Every roster tool is exposed with its JSON schema and
 * runs through `callTool`. The spending gate (`submit_proposal`) is exposed deliberately as
 * `approve_and_generate`, the human's approval step, under the same allowance. Two resource
 * templates let a client look at a project's state and at candidate files.
 * @packageDocumentation
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { IdSchema } from "@/lib/domain/common";
import { fail, toFailure } from "@/lib/domain/failure";
import { AGENT_TOOL_DESCRIPTIONS } from "@/server/agent/tools";
import { readAssetBytes } from "@/server/media/files";
import { INTERNAL_TOOLS, TOOLS, type ToolContext, callTool, toolsToJsonSchema } from "@/server/tools";

export const APPROVE_AND_GENERATE = "approve_and_generate";

const APPROVE_DESCRIPTION = [
  "Spends Comfy credits. This is the human's approval step: call it only after the user has seen a proposal (from propose_candidates, compose_still, generate_clip, generate_reference_sheet, or refine_still) and explicitly approved it.",
  "Submits the proposal as one generation job per candidate, gated by the same allowance as the app (GENERATION_ALLOWANCE_USD and the workspace allowance; zero blocks every paid run). Submitting the same proposal again never runs it twice.",
  "Pass confirmUnquoted only when the user accepted a reservation for a recipe without a live price; pass wait true to return once the candidates are finished.",
].join(" ");

const PROJECT_STATE = /^project:\/\/([^/]+)\/state$/;
const ASSET = /^asset:\/\/([^/]+)$/;

/**
 * What an MCP client may do beyond proposing: spend (approve_and_generate) and delete files for
 * good. Both are off until the person running the server sets MCP_ALLOW_SPEND=1 or
 * MCP_ALLOW_DELETE=1, because an MCP client has no proposal card to click.
 */
export interface McpPermissions {
  spend: boolean;
  delete: boolean;
}

export function mcpPermissions(env: Record<string, string | undefined> = process.env): McpPermissions {
  return { spend: env.MCP_ALLOW_SPEND === "1", delete: env.MCP_ALLOW_DELETE === "1" };
}

/** The tools offered over MCP: the roster, plus `approve_and_generate` and deletion when allowed. */
export function mcpTools(permissions: McpPermissions = mcpPermissions()): McpTool[] {
  const roster = toolsToJsonSchema(TOOLS.filter((tool) => permissions.delete || tool.name !== "delete_asset_everywhere")).map((tool) => ({
    name: tool.name,
    description: AGENT_TOOL_DESCRIPTIONS[tool.name] ?? tool.description,
    inputSchema: tool.input_schema as McpTool["inputSchema"],
  }));
  if (!permissions.spend) return roster;
  const [gate] = toolsToJsonSchema(INTERNAL_TOOLS.filter((tool) => tool.name === "submit_proposal"));
  return [...roster, { name: APPROVE_AND_GENERATE, description: APPROVE_DESCRIPTION, inputSchema: gate.input_schema as McpTool["inputSchema"] }];
}

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/**
 * Builds an MCP server over a tool context. The caller connects a transport and owns the store.
 * `log` receives one line per call (tool name and outcome code, never inputs or keys).
 */
export function createMcpServer(context: ToolContext, options: { version?: string; log?: (line: string) => void; permissions?: McpPermissions } = {}): Server {
  const log = options.log ?? (() => undefined);
  const permissions = options.permissions ?? mcpPermissions();
  const rosterNames = new Set(mcpTools(permissions).map((tool) => tool.name));
  const server = new Server(
    { name: "ai-creator-lab", version: options.version ?? "0.0.1" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        `AI Creator Lab: make a UGC ad from a brief, a Library character, a product, a script, stills, and clips. Read project://{id}/state first. Spending tools return proposals; ${permissions.spend ? "nothing is generated until the user approves a proposal and you call approve_and_generate" : "this server cannot run them (start it with MCP_ALLOW_SPEND=1 to allow approve_and_generate); the user runs proposals from the app"}.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools(permissions) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const internal = !rosterNames.has(name) ? undefined : name === APPROVE_AND_GENERATE ? "submit_proposal" : name;
    if (!internal) {
      log(`[mcp] ${name}: unknown tool`);
      return text({ code: "invalid", message: `There is no tool named ${name}.` }, true);
    }
    const result = await callTool(context, internal, request.params.arguments ?? {});
    log(`[mcp] ${name}: ${result.ok ? "ok" : result.failure.code}`);
    return result.ok ? text(result.output) : text(result.failure, true);
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: "project://{id}/state", name: "Project state", description: "Everything about one project, as get_project_state returns it.", mimeType: "application/json" },
      { uriTemplate: "asset://{id}", name: "Asset file", description: "An asset's file bytes (a candidate still, clip, sheet, or export), checked against its recorded hash." },
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: context.store.projects.list().map((project) => ({
      uri: `project://${project.id}/state`,
      name: project.name,
      mimeType: "application/json",
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => {
    const { uri } = request.params;
    try {
      const project = PROJECT_STATE.exec(uri);
      if (project) {
        const projectId = IdSchema.parse(project[1]);
        const result = await callTool(context, "get_project_state", { projectId });
        if (!result.ok) throw result.failure;
        return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result.output, null, 2) }] };
      }
      const assetMatch = ASSET.exec(uri);
      if (assetMatch) {
        const asset = context.store.assets.getRequired(IdSchema.parse(assetMatch[1]));
        const bytes = await readAssetBytes(context.store.dataDir, asset);
        return { contents: [{ uri, mimeType: asset.mime, blob: bytes.toString("base64") }] };
      }
      fail("not_found", "Use project://{id}/state or asset://{id}.");
    } catch (error) {
      const failure = toFailure(error);
      log(`[mcp] read resource: ${failure.code}`);
      throw new Error(failure.code === "storage" ? "The resource could not be read." : failure.message);
    }
  });

  return server;
}
