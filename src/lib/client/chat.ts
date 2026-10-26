/**
 * Folds streamed assistant events into the chat transcript. Pure, so the chat panel and the tests
 * share one definition of how text, tool activity, proposals, and errors appear.
 * @packageDocumentation
 */
import type { ChatItem } from "@/components/project/project-context";
import type { GenerationProposal } from "@/lib/client/types";
import type { AgentEvent } from "@/server/agent";

const AGENT_EVENT_TYPES = new Set(["text", "tool_call", "tool_result", "proposal", "done", "error"]);

/** Parses one SSE data payload into an AgentEvent, or null when it is not one. */
export function parseAgentEvent(data: string): AgentEvent | null {
  try {
    const value = JSON.parse(data) as { type?: unknown };
    return value && typeof value.type === "string" && AGENT_EVENT_TYPES.has(value.type) ? (value as AgentEvent) : null;
  } catch {
    return null;
  }
}

/**
 * Applies one event. `turnStart` is the transcript length when this turn began, so text after a
 * tool card starts a new assistant bubble instead of extending an earlier one.
 */
export function applyAgentEvent(items: ChatItem[], event: AgentEvent, turnStart: number, newId: (prefix: string) => string): ChatItem[] {
  switch (event.type) {
    case "text": {
      const last = items.at(-1);
      if (last && last.kind === "assistant" && items.length > turnStart) {
        return [...items.slice(0, -1), { ...last, text: last.text + event.delta }];
      }
      return [...items, { kind: "assistant", id: newId("assistant"), text: event.delta }];
    }
    case "tool_call":
      return [...items, { kind: "tool", id: `tool-${event.id}`, activity: { id: event.id, name: event.name, input: event.input, status: "running" } }];
    case "tool_result": {
      const index = items.findIndex((item) => item.kind === "tool" && item.activity.id === event.id);
      const activity = { id: event.id, name: event.name, input: undefined as unknown, status: event.ok ? ("ok" as const) : ("error" as const), output: event.output };
      if (index === -1) return [...items, { kind: "tool", id: `tool-${event.id}`, activity }];
      const current = items[index];
      if (current.kind !== "tool") return items;
      const next = [...items];
      next[index] = { ...current, activity: { ...current.activity, status: activity.status, output: event.output } };
      return next;
    }
    case "proposal":
      return [...items, { kind: "proposal", id: `proposal-${event.proposal.id}`, proposal: event.proposal, source: "assistant" }];
    case "error":
      return [...items, { kind: "notice", id: newId("error"), tone: "error", text: event.message }];
    case "done":
      return items;
  }
}

/** A stored conversation message, as the chat route returns it. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  )[];
}

function parseOutput(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function looksLikeProposal(value: unknown): value is GenerationProposal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.recipeTitle === "string" && typeof candidate.estimate === "object" && typeof candidate.target === "object";
}

/**
 * Rebuilds the transcript from stored messages: text bubbles, tool cards with their results, and
 * proposal cards for proposals the assistant made (shown again for a decision; submitting one twice
 * never runs it twice).
 */
export function historyToItems(messages: StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, number>();
  for (const message of messages) {
    for (const [index, block] of message.content.entries()) {
      if (block.type === "text") {
        items.push({ kind: message.role, id: `${message.id}-${index}`, text: block.text });
      } else if (block.type === "tool_use") {
        tools.set(block.id, items.length);
        items.push({ kind: "tool", id: `tool-${block.id}`, activity: { id: block.id, name: block.name, input: block.input, status: "running" } });
      } else {
        const output = parseOutput(block.content);
        const position = tools.get(block.tool_use_id);
        const current = position === undefined ? undefined : items[position];
        if (current && current.kind === "tool") {
          items[position!] = { ...current, activity: { ...current.activity, status: block.is_error ? "error" : "ok", output } };
        }
        if (!block.is_error && looksLikeProposal(output)) {
          items.push({ kind: "proposal", id: `proposal-${output.id}`, proposal: output, source: "history" });
        }
      }
    }
  }
  return items.map((item) => (item.kind === "tool" && item.activity.status === "running" ? { ...item, activity: { ...item.activity, status: "error" } } : item));
}
