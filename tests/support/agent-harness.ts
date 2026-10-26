/**
 * An offline harness for the agent: a temp store, the mock executor with mock recipes only (so no
 * test can reach a paid provider), a turn runner that collects events, and the UI's approval gate.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import type { GenerationProposal } from "@/lib/domain/job";
import type { Project } from "@/lib/domain/project";
import { type AgentEvent, type LlmModel, runAgentTurn } from "@/server/agent";
import { MOCK_RECIPES } from "@/server/catalog/defaults";
import { createExecutors } from "@/server/executors";
import type { Store } from "@/server/store";
import { type ToolContext, callTool } from "@/server/tools";
import { clock, seedProject, tempStore } from "./domain-fixtures";

export interface Harness {
  store: Store;
  now: () => number;
  tools: ToolContext;
  project: Project;
  cleanup: () => void;
}

export function agentHarness(): Harness {
  const { store, cleanup } = tempStore();
  const now = clock();
  const tools: ToolContext = {
    store,
    now,
    newId: randomUUID,
    generation: { executors: createExecutors({ jobs: store.jobs, mediaRoot: store.dataDir }), recipes: async () => MOCK_RECIPES },
  };
  return { store, now, tools, project: seedProject(store, now), cleanup };
}

export interface TurnResult {
  events: AgentEvent[];
  text: string;
  toolCalls: Extract<AgentEvent, { type: "tool_call" }>[];
  toolResults: Extract<AgentEvent, { type: "tool_result" }>[];
  proposals: GenerationProposal[];
  done?: Extract<AgentEvent, { type: "done" }>;
  error?: string;
}

export async function runTurn(
  harness: Pick<Harness, "tools" | "project">,
  userMessage: string,
  model: LlmModel,
  options: { signal?: AbortSignal; onEvent?: (event: AgentEvent) => void } = {},
): Promise<TurnResult> {
  const result: TurnResult = { events: [], text: "", toolCalls: [], toolResults: [], proposals: [] };
  for await (const event of runAgentTurn(harness.tools, { projectId: harness.project.id, userMessage }, { model, signal: options.signal })) {
    result.events.push(event);
    options.onEvent?.(event);
    if (event.type === "text") result.text += event.delta;
    if (event.type === "tool_call") result.toolCalls.push(event);
    if (event.type === "tool_result") result.toolResults.push(event);
    if (event.type === "proposal") result.proposals.push(event.proposal);
    if (event.type === "done") result.done = event;
    if (event.type === "error") result.error = event.message;
  }
  return result;
}

/** What the UI gate does when the user approves a proposal card: submit it and wait for the mock. */
export async function approveProposal(tools: ToolContext, proposal: GenerationProposal): Promise<string[]> {
  const result = await callTool(tools, "submit_proposal", { proposal, wait: true });
  if (!result.ok) throw new Error(`submit_proposal failed: ${result.failure.message}`);
  const { results } = result.output as { results: { outcome: string; assetIds: string[] }[] };
  if (results.some((entry) => entry.outcome !== "completed")) throw new Error(`Not every candidate completed: ${JSON.stringify(results)}`);
  return results.flatMap((entry) => entry.assetIds);
}

/** The text of the tool result the loop sent back for a tool_use id. */
export function toolResultFor(messages: { role: string; content: { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[] }[], id: string) {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.tool_use_id === id) return { content: String(block.content), isError: block.is_error === true };
    }
  }
  return undefined;
}

type SentMessages = Parameters<typeof toolResultFor>[0];

/** Parses the JSON a successful tool result carried back to the model. */
export function resultJson<T = Record<string, unknown>>(messages: SentMessages, id: string): T {
  const result = toolResultFor(messages, id);
  if (!result || result.isError) throw new Error(`Tool result ${id} is missing or failed: ${result?.content}`);
  return JSON.parse(result.content) as T;
}

/** The exact prompt the stage guidance handed the model ("...and exactly this prompt:\n<prompt>"). */
export function guidedPrompt(system: { text: string }[]): string {
  const match = system.map((block) => block.text).join("\n").match(/exactly this prompt:\n(.+)/);
  if (!match) throw new Error("The stage guidance has no prompt.");
  return match[1];
}

/** Candidate ids the stage guidance says are waiting for the user. */
export function waitingIds(system: { text: string }[]): string[] {
  const match = system.map((block) => block.text).join("\n").match(/waiting for the user in the workspace: ([^\n]+)\./);
  return match ? match[1].split(", ") : [];
}

/** A value from the state block, such as `characterId` or `productId`. */
export function stateValue(system: { text: string }[], key: string): string {
  const match = system.map((block) => block.text).join("\n").match(new RegExp(`${key} ([0-9a-f-]{36}|\\d+)`));
  if (!match) throw new Error(`No ${key} in the system prompt.`);
  return match[1];
}
