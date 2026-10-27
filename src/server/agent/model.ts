/**
 * The model port the agent loop talks to, with two implementations: the Anthropic API (streaming,
 * Anthropic key) and Comfy Router (the same Messages body, Comfy key only, one complete reply).
 * Tests replace both with a scripted model, so the loop runs with no network.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { comfy } from "@comfyorg/sdk";
import { z } from "zod";
import type {
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages";
import type { ApiMessage } from "@/lib/domain/conversation";
import { ServiceError, fail } from "@/lib/domain/failure";

/** The assistant model when `LLM_MODEL` is not set. */
export const DEFAULT_LLM_MODEL = "claude-opus-5-5";

export interface Usage {
  /** All input tokens of the call, cached or not (uncached = inputTokens - cacheRead - cacheCreation). */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache. */
  cacheReadInputTokens: number;
  /** Input tokens written to the prompt cache by this call. */
  cacheCreationInputTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

export function addUsage(total: Usage, part: Usage): Usage {
  return {
    inputTokens: total.inputTokens + part.inputTokens,
    outputTokens: total.outputTokens + part.outputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + part.cacheReadInputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens + part.cacheCreationInputTokens,
  };
}

export interface StreamParams {
  /**
   * System prompt blocks; blocks marked `cache` get a cache breakpoint. The loop sends only the
   * stable creative director prompt here and puts per-turn project state in the conversation, so
   * the cached prefix (tools, then system) is byte-identical across rounds and turns.
   */
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
  const usage = emptyUsage();
  let stopReason: string | null = null;
  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        const start = event.message.usage;
        usage.cacheReadInputTokens = start.cache_read_input_tokens ?? 0;
        usage.cacheCreationInputTokens = start.cache_creation_input_tokens ?? 0;
        usage.inputTokens = start.input_tokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
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
        if (event.usage.cache_read_input_tokens !== null && event.usage.cache_read_input_tokens !== undefined) {
          usage.cacheReadInputTokens = event.usage.cache_read_input_tokens;
        }
        if (event.usage.cache_creation_input_tokens !== null && event.usage.cache_creation_input_tokens !== undefined) {
          usage.cacheCreationInputTokens = event.usage.cache_creation_input_tokens;
        }
        if (event.usage.input_tokens !== null && event.usage.input_tokens !== undefined) {
          usage.inputTokens = event.usage.input_tokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
        }
        break;
      case "message_stop":
        break;
    }
  }
  yield { type: "stop", stopReason, usage };
}

const EPHEMERAL = { type: "ephemeral" as const };

/**
 * The Messages API request for one model call, with prompt-cache breakpoints: the last tool
 * definition (caching every tool), each system block marked `cache`, and the last content block of
 * the last message (incremental caching, so the next round of the same turn reads the whole
 * conversation so far from the cache). The API orders the cached prefix tools, system, messages.
 * Inputs are copied, never mutated.
 */
export function buildRequest(params: StreamParams, model: string): MessageCreateParamsStreaming {
  const tools = params.tools.map((tool, index) => (index === params.tools.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool));
  const messages = params.messages.map((message, index): MessageParam => {
    if (index !== params.messages.length - 1) return message as MessageParam;
    const content = message.content.map((block, position) => (position === message.content.length - 1 ? { ...block, cache_control: EPHEMERAL } : block));
    return { role: message.role, content } as MessageParam;
  });
  return {
    model,
    max_tokens: params.maxTokens,
    stream: true,
    tools,
    system: params.system.map((block) => ({ type: "text" as const, text: block.text, ...(block.cache ? { cache_control: EPHEMERAL } : {}) })),
    messages,
    ...(params.toolChoice ? { tool_choice: { type: params.toolChoice } } : {}),
  };
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
      const stream = await client.messages.create(buildRequest(params, model), { signal: params.signal });
      yield* translateStream(stream);
    },
  };
}

/** The slice of `comfy.models` the Router assistant uses; tests pass a fake with recorded replies. */
export interface RouterMessagesPort {
  run(model: string, input: Record<string, unknown>, options?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<{ kind: string; data?: unknown }>;
}

const tokenCount = z.number().int().nonnegative().nullable().optional();

/** The non-streamed Messages API reply Router returns for `anthropic/*` models. */
export const RouterMessageSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string() })),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .looseObject({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      cache_read_input_tokens: tokenCount,
      cache_creation_input_tokens: tokenCount,
    })
    .optional(),
});

/**
 * Turns a complete Messages reply into the events the streaming adapter emits: one text delta per
 * text block, each tool_use as-is, then the stop with usage (cache fields included). Thinking blocks
 * are not shown or stored, so they are skipped.
 */
export function messageEvents(reply: unknown): ModelEvent[] {
  const parsed = RouterMessageSchema.safeParse(reply);
  if (!parsed.success) fail("provider", "Comfy Router returned a reply the assistant could not read.");
  const events: ModelEvent[] = [];
  for (const block of parsed.data.content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      events.push({ type: "text", delta: block.text });
    } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      events.push({ type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  const usage = parsed.data.usage ?? {};
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  events.push({
    type: "stop",
    stopReason: parsed.data.stop_reason ?? null,
    usage: {
      inputTokens: (usage.input_tokens ?? 0) + cacheReadInputTokens + cacheCreationInputTokens,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    },
  });
  return events;
}

/**
 * The assistant on Comfy Router with only the Comfy key: posts the identical Messages body
 * (system, tools, messages, and cache breakpoints; Router forwards it unchanged) to
 * `anthropic/<model>` without streaming, and replays the complete reply as {@link ModelEvent}s.
 * Each call gets its own idempotency key. The key defaults to `COMFY_API_KEY`.
 */
export function routerModel(options: { apiKey?: string; model?: string; models?: RouterMessagesPort } = {}): LlmModel {
  return {
    async *stream(params) {
      let models = options.models;
      if (!models) {
        const apiKey = options.apiKey?.trim() || process.env.COMFY_API_KEY?.trim();
        if (!apiKey) fail("invalid", "Add a Comfy API key in Settings to use the assistant through Comfy Router.");
        comfy.config({ credentials: apiKey });
        models = comfy.models;
      }
      const model = (options.model?.trim() || process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL).replace(/^anthropic\//, "");
      const { stream, ...body } = buildRequest(params, model);
      void stream;
      let result: { kind: string; data?: unknown };
      try {
        result = await models.run(`anthropic/${model}`, body as unknown as Record<string, unknown>, { idempotencyKey: randomUUID(), signal: params.signal });
      } catch (error) {
        if (params.signal?.aborted || error instanceof ServiceError) throw error;
        const detail = error instanceof Error ? ` ${error.message.slice(0, 200)}` : "";
        fail("provider", `Comfy Router could not run the assistant.${detail}`);
      }
      if (result.kind !== "json") fail("provider", "Comfy Router returned a file instead of a message.");
      yield* messageEvents(result.data);
    },
  };
}

/** The assistant for the configured provider: Comfy Router when `llmProvider` is "router", else the Anthropic API. */
export function assistantModel(settings: { llmProvider?: string; anthropicApiKey?: string; comfyApiKey?: string; llmModel?: string }): LlmModel {
  return settings.llmProvider === "router"
    ? routerModel({ apiKey: settings.comfyApiKey, model: settings.llmModel })
    : anthropicModel({ apiKey: settings.anthropicApiKey, model: settings.llmModel });
}
