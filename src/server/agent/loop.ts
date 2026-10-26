/**
 * One assistant turn: persist the user's message, stream the model, run the tool calls it makes
 * through the registry, feed the results back, and loop until the model stops. Every assistant
 * message is saved together with its tool results, so the stored transcript always replays.
 * @packageDocumentation
 */
import { z } from "zod";
import {
  type ApiMessage,
  type ContentBlock,
  type ConversationMessage,
  type ToolResultBlock,
  type ToolUseBlock,
  toApiMessages,
  windowMessages,
} from "@/lib/domain/conversation";
import { ServiceError } from "@/lib/domain/failure";
import { type GenerationProposal, GenerationProposalSchema } from "@/lib/domain/job";
import { type LlmModel, type Usage, addUsage, anthropicModel, emptyUsage } from "@/server/agent/model";
import { stagePrompt, systemPrompt } from "@/server/agent/prompts/creative-director";
import { loadSnapshot, renderSnapshot } from "@/server/agent/state";
import { agentToolNames, agentTools } from "@/server/agent/tools";
import { conversationsOf } from "@/server/store/conversations";
import { type ToolContext, callTool, getTool } from "@/server/tools";

export interface AgentTurnInput {
  projectId: string;
  userMessage: string;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: unknown }
  | { type: "proposal"; proposal: GenerationProposal }
  | { type: "done"; messageId: string; usage: AgentUsage }
  | { type: "error"; message: string };

/**
 * Token usage of a whole turn. `inputTokens` counts every input token, cached or not; the cache
 * fields were added later and are optional in the type so older consumers keep compiling, but the
 * loop always sets them.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface AgentTurnOptions {
  signal?: AbortSignal;
  model?: LlmModel;
}

/** Tool calls executed per turn; later calls are refused and the model answers in text. */
export const MAX_TOOL_CALLS = 8;
/** Model calls per turn, a backstop against a model that keeps calling refused tools. */
export const MAX_MODEL_CALLS = 10;
/** Turns of history sent to the model; older turns are summarized by the project state. */
export const WINDOW_TURNS = 12;
export const MAX_OUTPUT_TOKENS = 4096;
/** Longest tool result text sent back to the model. */
export const RESULT_LIMIT = 12_000;
export const MAX_USER_MESSAGE = 8_000;

export const STOPPED_MESSAGE = "Stopped. Nothing after this point was saved.";

/** A readable message for a model failure; never includes keys or raw provider payloads. */
export function describeModelError(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : NaN;
  if (status === 401 || status === 403) return "The Anthropic key was rejected. Check it in Settings.";
  if (status === 404) return "The assistant model was not found. Check the model name in Settings.";
  if (status === 429) return "The assistant is rate limited right now. Try again in a minute.";
  if (status >= 500) return "The assistant service is busy. Try again in a moment.";
  if (status === 400) return "The assistant could not read this conversation. Try again, or start a new message.";
  return "The assistant stopped unexpectedly. Try again.";
}

function estimateText(proposal: GenerationProposal): string {
  const { estimate } = proposal;
  switch (estimate.kind) {
    case "free":
      return "free";
    case "quoted":
      return `about $${estimate.usd?.toFixed(3)} per candidate${estimate.credits !== null ? ` (${estimate.credits} credits)` : ""}`;
    case "unquoted":
      return `up to $${estimate.usd?.toFixed(3)} per candidate (no live price; the user confirms a reservation)`;
    case "rejected":
      return `cannot run: ${estimate.note}`;
  }
}

/** What the model reads back from a successful tool call. */
function resultText(context: ToolContext, projectId: string, name: string, output: unknown): string {
  const proposal = GenerationProposalSchema.safeParse(output);
  if (proposal.success) {
    const p = proposal.data;
    return [
      `Proposal ${p.id} is waiting for the user's approval on its card. Nothing has been generated.`,
      `${p.count} candidate(s) with ${p.recipeTitle} (${p.capability}), ${p.references.length} reference image(s), estimate ${estimateText(p)}.`,
      `Target: ${JSON.stringify(p.target)}.`,
    ].join(" ");
  }
  if (name === "get_project_state") {
    const snapshot = loadSnapshot(context.store, projectId);
    if (snapshot) return renderSnapshot(snapshot);
  }
  const json = JSON.stringify(output);
  return json.length > RESULT_LIMIT ? `${json.slice(0, RESULT_LIMIT)}… (truncated)` : json;
}

interface TurnBudget {
  toolCalls: number;
  invalid: Map<string, number>;
}

interface ToolOutcome {
  ok: boolean;
  output: unknown;
  block: ToolResultBlock;
  proposal?: GenerationProposal;
}

function refused(use: ToolUseBlock, message: string, code = "invalid"): ToolOutcome {
  return { ok: false, output: { code, message }, block: { type: "tool_result", tool_use_id: use.id, content: `${code}: ${message}`, is_error: true } };
}

async function runTool(context: ToolContext, projectId: string, use: ToolUseBlock, budget: TurnBudget): Promise<ToolOutcome> {
  const tool = getTool(use.name);
  if (!tool || !agentToolNames().has(use.name)) return refused(use, `${use.name} is not available to the assistant.`);
  if (budget.toolCalls >= MAX_TOOL_CALLS) {
    return refused(use, `The limit of ${MAX_TOOL_CALLS} tool calls for one reply is reached. Do not call more tools; tell the user where things stand and what comes next.`, "budget");
  }
  const invalidSoFar = budget.invalid.get(use.name) ?? 0;
  if (invalidSoFar >= 2) return refused(use, `${use.name} input failed validation twice in this reply. Do not call it again now; tell the user in one sentence what you were trying to do.`);
  budget.toolCalls += 1;
  const input = use.input;
  if (typeof input === "object" && input !== null && "projectId" in input && (input as { projectId: unknown }).projectId !== projectId) {
    return refused(use, `This conversation belongs to project ${projectId}; use that projectId.`);
  }
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    budget.invalid.set(use.name, invalidSoFar + 1);
    const detail = z.prettifyError(parsed.error);
    return refused(
      use,
      invalidSoFar === 0
        ? `Invalid input for ${use.name}:\n${detail}\nFix the input and call ${use.name} again.`
        : `Invalid input for ${use.name} again:\n${detail}\nDo not retry; tell the user in one sentence what went wrong.`,
    );
  }
  const result = await callTool(context, use.name, input);
  if (!result.ok) return refused(use, result.failure.message, result.failure.code);
  const proposal = GenerationProposalSchema.safeParse(result.output);
  return {
    ok: true,
    output: result.output,
    block: { type: "tool_result", tool_use_id: use.id, content: resultText(context, projectId, use.name, result.output) },
    proposal: proposal.success ? proposal.data : undefined,
  };
}

/** Text blocks the API accepts (non-blank), in order, with tool calls kept where they were. */
function cleanContent(content: ContentBlock[], keepToolUse: boolean): ContentBlock[] {
  return content.filter((block) => (block.type === "text" ? block.text.trim().length > 0 : keepToolUse || block.type !== "tool_use"));
}

/**
 * The project state block for the conversation side. Within a turn the earlier blocks stay as they
 * were sent, so every round's request extends the previous one and reads it from the prompt cache.
 */
function stateBlock(context: ToolContext, projectId: string, omittedTurns: number): ContentBlock {
  return { type: "text", text: stagePrompt(loadSnapshot(context.store, projectId)!, { omittedTurns }) };
}

/**
 * Runs one assistant turn and streams what happens. Never throws: failures end the stream with an
 * `error` event; a normal end is a `done` event with the last saved message id and token usage.
 */
export async function* runAgentTurn(context: ToolContext, input: AgentTurnInput, options: AgentTurnOptions = {}): AsyncGenerator<AgentEvent> {
  const { signal } = options;
  const { projectId } = input;
  const text = input.userMessage.trim();
  if (!text) {
    yield { type: "error", message: "Type a message first." };
    return;
  }
  if (text.length > MAX_USER_MESSAGE) {
    yield { type: "error", message: `Keep a message under ${MAX_USER_MESSAGE} characters.` };
    return;
  }
  if (!loadSnapshot(context.store, projectId)) {
    yield { type: "error", message: "This project could not be found." };
    return;
  }
  const conversations = conversationsOf(context.store);
  const message = (role: ConversationMessage["role"], content: ContentBlock[]): ConversationMessage => ({
    id: context.newId(),
    projectId,
    role,
    content,
    createdAt: context.now(),
  });
  const userMessage = message("user", [{ type: "text", text }]);
  conversations.append(userMessage);
  let lastMessageId = userMessage.id;

  const window = windowMessages(conversations.listByProject(projectId), WINDOW_TURNS);
  // The state is sent, not stored: it goes ahead of the user's words in the last message.
  let lastState = stateBlock(context, projectId, window.omittedTurns);
  let messages: ApiMessage[] = toApiMessages(window.messages);
  const last = messages.at(-1)!;
  messages = [...messages.slice(0, -1), { role: last.role, content: [...last.content.slice(0, -1), lastState, last.content.at(-1)!] }];
  const system = systemPrompt();
  let usage: Usage = emptyUsage();
  const budget: TurnBudget = { toolCalls: 0, invalid: new Map() };
  const tools = agentTools();
  let model: LlmModel;
  try {
    model = options.model ?? anthropicModel();
  } catch (error) {
    yield { type: "error", message: describeModelError(error) };
    return;
  }

  const saveText = (content: ContentBlock[], callUsage?: Usage) => {
    const kept = cleanContent(content, false);
    if (kept.length === 0) return;
    lastMessageId = conversations.append({ ...message("assistant", kept), ...(callUsage ? { usage: callUsage } : {}) })[0].id;
  };

  for (let call = 0; call < MAX_MODEL_CALLS; call += 1) {
    if (signal?.aborted) {
      yield { type: "error", message: STOPPED_MESSAGE };
      return;
    }
    const content: ContentBlock[] = [];
    const toolUses: ToolUseBlock[] = [];
    let callUsage: Usage | undefined;
    try {
      const stream = model.stream({
        system,
        messages,
        tools,
        toolChoice: budget.toolCalls >= MAX_TOOL_CALLS ? "none" : undefined,
        maxTokens: MAX_OUTPUT_TOKENS,
        signal,
      });
      for await (const event of stream) {
        if (signal?.aborted) break;
        if (event.type === "text") {
          const last = content.at(-1);
          if (last?.type === "text") last.text += event.delta;
          else content.push({ type: "text", text: event.delta });
          yield { type: "text", delta: event.delta };
        } else if (event.type === "tool_use") {
          const block: ToolUseBlock = { type: "tool_use", id: event.id, name: event.name, input: event.input ?? {} };
          content.push(block);
          toolUses.push(block);
        } else {
          callUsage = callUsage ? addUsage(callUsage, event.usage) : event.usage;
          usage = addUsage(usage, event.usage);
        }
      }
    } catch (error) {
      saveText(content, callUsage);
      yield { type: "error", message: signal?.aborted ? STOPPED_MESSAGE : describeModelError(error) };
      return;
    }
    if (signal?.aborted) {
      saveText(content, callUsage);
      yield { type: "error", message: STOPPED_MESSAGE };
      return;
    }
    if (toolUses.length === 0) {
      saveText(content, callUsage);
      break;
    }

    const results: ToolResultBlock[] = [];
    for (const use of toolUses) {
      if (signal?.aborted) {
        results.push(refused(use, "Cancelled by the user before it ran.").block);
        continue;
      }
      yield { type: "tool_call", id: use.id, name: use.name, input: use.input };
      const outcome = await runTool(context, projectId, use, budget);
      results.push(outcome.block);
      yield { type: "tool_result", id: use.id, name: use.name, ok: outcome.ok, output: outcome.output };
      if (outcome.proposal) yield { type: "proposal", proposal: outcome.proposal };
    }
    const assistant: ConversationMessage = { ...message("assistant", cleanContent(content, true)), ...(callUsage ? { usage: callUsage } : {}) };
    conversations.append(assistant, message("user", results));
    lastMessageId = assistant.id;
    // Tool results first, then the refreshed state when the tools changed it.
    const state = stateBlock(context, projectId, window.omittedTurns);
    const changed = state.type === "text" && lastState.type === "text" && state.text !== lastState.text;
    if (changed) lastState = state;
    messages = [...messages, { role: "assistant", content: assistant.content }, { role: "user", content: changed ? [...results, state] : results }];
    if (signal?.aborted) {
      yield { type: "error", message: STOPPED_MESSAGE };
      return;
    }
  }
  yield { type: "done", messageId: lastMessageId, usage };
}
