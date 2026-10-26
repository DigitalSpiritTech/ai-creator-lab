/**
 * The model port the agent loop talks to, and its Anthropic implementation. Tests replace it with
 * a scripted model, so the loop runs with no network.
 * @packageDocumentation
 */
import Anthropic from "@anthropic-ai/sdk";
import type { RawMessageStreamEvent, Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import type { ApiMessage } from "@/lib/domain/conversation";
import { fail } from "@/lib/domain/failure";

/** The assistant model when `LLM_MODEL` is not set. */
export const DEFAULT_LLM_MODEL = "claude-opus-5-5";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface StreamParams {
  /** System prompt blocks; blocks marked `cache` are stable across turns and cached by the API. */
  system: { text: string; cache?: boolean }[];
  messages: ApiMessage[];
  tools: AnthropicTool[];
  /** "none" lets the model answer in text only (used once the tool budget for a turn is spent). */
  toolChoice?: "auto" | "none";
  maxTokens: number;
  signal?: AbortSignal;
}

/** What one model response streams: text as it arrives, each finished tool call, then the stop. */
export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "stop"; stopReason: string | null; usage: Usage };

export interface LlmModel {
  stream(params: StreamParams): AsyncIterable<ModelEvent>;
}

/** Parses a streamed tool input; malformed JSON is passed on so input validation reports it. */
function parseToolInput(json: string): unknown {
  if (json.trim() === "") return {};
  try {
    return JSON.parse(json);
  } catch {
    return { invalidJson: json.slice(0, 2000) };
  }
}

/** Translates the Messages API's raw stream events into {@link ModelEvent}s. */
export async function* translateStream(events: AsyncIterable<RawMessageStreamEvent>): AsyncIterable<ModelEvent> {
  const tools = new Map<number, { id: string; name: string; json: string }>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: string | null = null;
  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        const start = event.message.usage;
        usage.inputTokens = start.input_tokens + (start.cache_creation_input_tokens ?? 0) + (start.cache_read_input_tokens ?? 0);
        usage.outputTokens = start.output_tokens;
        break;
      }
      case "content_block_start":
        if (event.content_block.type === "tool_use") {
          tools.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
        }
        break;
      case "content_block_delta":
        if (event.delta.type === "text_delta") yield { type: "text", delta: event.delta.text };
        else if (event.delta.type === "input_json_delta") {
          const tool = tools.get(event.index);
          if (tool) tool.json += event.delta.partial_json;
        }
        break;
      case "content_block_stop": {
        const tool = tools.get(event.index);
        if (tool) {
          tools.delete(event.index);
          yield { type: "tool_use", id: tool.id, name: tool.name, input: parseToolInput(tool.json) };
        }
        break;
      }
      case "message_delta":
        stopReason = event.delta.stop_reason ?? stopReason;
        usage.outputTokens = event.usage.output_tokens;
        if (event.usage.input_tokens !== null && event.usage.input_tokens !== undefined) {
          usage.inputTokens = event.usage.input_tokens + (event.usage.cache_creation_input_tokens ?? 0) + (event.usage.cache_read_input_tokens ?? 0);
        }
        break;
      case "message_stop":
        break;
    }
  }
  yield { type: "stop", stopReason, usage };
}

/**
 * The Anthropic Messages API as an {@link LlmModel}: streaming, tool use, and prompt caching on the
 * stable system block and the tool list. The key and model default to `ANTHROPIC_API_KEY` and
 * `LLM_MODEL`; the client is created on the first call, so constructing this never touches the network.
 */
export function anthropicModel(options: { apiKey?: string; model?: string } = {}): LlmModel {
  let client: Anthropic | undefined;
  return {
    async *stream(params) {
      const apiKey = options.apiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey) fail("invalid", "Add an Anthropic API key in Settings to use the assistant.");
      client ??= new Anthropic({ apiKey });
      const model = options.model?.trim() || process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
      const tools = params.tools.map((tool, index) =>
        index === params.tools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" as const } } : tool,
      );
      const stream = await client.messages.create(
        {
          model,
          max_tokens: params.maxTokens,
          stream: true,
          system: params.system.map((block) => ({
            type: "text" as const,
            text: block.text,
            ...(block.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
          })),
          messages: params.messages,
          tools,
          ...(params.toolChoice ? { tool_choice: { type: params.toolChoice } } : {}),
        },
        { signal: params.signal },
      );
      yield* translateStream(stream);
    },
  };
}
