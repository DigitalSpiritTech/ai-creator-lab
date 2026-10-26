/**
 * The MCP server in-process over the SDK's in-memory transport, on a temp data directory with the
 * mock executor. No network, no credits.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { APPROVE_AND_GENERATE, createMcpServer } from "@/server/mcp/server";
import { INTERNAL_TOOLS, TOOLS, type ToolContext, createGenerationContext } from "@/server/tools";
import { clock, generateAssets, seedProject, tempStore } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../workflows", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const tools: ToolContext = { store: context.store, now, newId: randomUUID, generation: createGenerationContext(context.store, { workflowsDir }) };
  const lines: string[] = [];
  const server = createMcpServer(tools, { log: (line) => lines.push(line) });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { ...context, now, client, lines, project: seedProject(context.store, now) };
}

function json(result: unknown): unknown {
  const [first] = (result as { content: { type: string; text: string }[] }).content;
  assert.equal(first.type, "text");
  return JSON.parse(first.text);
}

describe("MCP server", () => {
  test("lists every roster tool plus approve_and_generate, and never the internal name", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.ok(TOOLS.length >= 22);
    assert.equal(tools.length, TOOLS.length + 1);
    assert.deepEqual(tools.map((tool) => tool.name), [...TOOLS.map((tool) => tool.name), APPROVE_AND_GENERATE]);
    for (const internal of INTERNAL_TOOLS) assert.equal(tools.some((tool) => tool.name === internal.name), false);
    const gate = tools.find((tool) => tool.name === APPROVE_AND_GENERATE)!;
    assert.match(gate.description ?? "", /Spends Comfy credits\. This is the human's approval step/);
    assert.equal(gate.inputSchema.type, "object");
    assert.ok(tools.every((tool) => tool.inputSchema.type === "object" && (tool.description ?? "").length > 20));
  });

  test("get_project_state, propose_candidates, and approve_and_generate run through callTool", async () => {
    const { client, project, lines } = await connect();
    const state = json(await client.callTool({ name: "get_project_state", arguments: { projectId: project.id } })) as { project: { name: string } };
    assert.equal(state.project.name, project.name);

    const proposal = json(
      await client.callTool({
        name: "propose_candidates",
        arguments: { projectId: project.id, capability: "text_to_image", prompt: "Avery Lane portrait, head turned about thirty degrees.", count: 2 },
      }),
    ) as { recipeId: string; estimate: { kind: string } };
    assert.equal(proposal.recipeId, "mock-text-to-image");
    assert.equal(proposal.estimate.kind, "free");

    const generated = json(await client.callTool({ name: APPROVE_AND_GENERATE, arguments: { proposal, wait: true } })) as { results: { outcome: string }[] };
    assert.deepEqual(generated.results.map((result) => result.outcome), ["completed", "completed"]);

    const invalid = await client.callTool({ name: "save_brief", arguments: { projectId: "nope" } });
    assert.equal(invalid.isError, true);
    assert.equal((json(invalid) as { code: string }).code, "invalid");
    const unknown = await client.callTool({ name: "submit_proposal", arguments: { proposal } });
    assert.equal(unknown.isError, true, "the internal name is not callable over MCP");
    assert.deepEqual(lines.slice(0, 3), ["[mcp] get_project_state: ok", "[mcp] propose_candidates: ok", `[mcp] ${APPROVE_AND_GENERATE}: ok`]);
    assert.ok(lines.every((line) => !line.includes("Avery")), "logs carry no inputs");
  });

  test("project state and asset files are readable as resources", async () => {
    const { client, project, store, now } = await connect();
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.deepEqual(resourceTemplates.map((template) => template.uriTemplate), ["project://{id}/state", "asset://{id}"]);
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((resource) => resource.uri), [`project://${project.id}/state`]);

    const { assetIds } = await generateAssets(store, now, { projectId: project.id });
    const stateRead = await client.readResource({ uri: `project://${project.id}/state` });
    const [stateContent] = stateRead.contents as { mimeType: string; text: string }[];
    assert.equal(stateContent.mimeType, "application/json");
    assert.ok((JSON.parse(stateContent.text) as { assets: { id: string }[] }).assets.some((asset) => asset.id === assetIds[0]));

    const asset = store.assets.getRequired(assetIds[0]);
    const fileRead = await client.readResource({ uri: `asset://${asset.id}` });
    const [file] = fileRead.contents as { mimeType: string; blob: string }[];
    assert.equal(file.mimeType, "image/png");
    assert.equal(Buffer.from(file.blob, "base64").toString(), `image-${asset.provenance.source === "generated" ? asset.provenance.jobId : ""}-0`);

    await assert.rejects(client.readResource({ uri: `asset://${randomUUID()}` }), /could not be found/);
    await assert.rejects(client.readResource({ uri: "file:///etc/passwd" }), /project:\/\/\{id\}\/state or asset:\/\/\{id\}/);
  });
});
