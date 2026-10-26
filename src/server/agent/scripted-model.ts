/**
 * A scripted {@link LlmModel} that replays recorded model responses, for offline tests, evals, and
 * demos without an Anthropic key. Each `stream` call plays the next step and records its params.
 * @packageDocumentation
 */
import type { LlmModel, ModelEvent, StreamParams, Usage } from "@/server/agent/model";

/** One model response: fixed events, or events computed from what the loop sent (ids, results). */
export type ScriptedStep = ModelEvent[] | ((params: StreamParams, call: number) => ModelEvent[]);

export interface ScriptedModel extends LlmModel {
  /** Params of every call so far, in order. */
  readonly calls: StreamParams[];
  /** Steps not yet played. */
  remaining(): number;
}

let toolSequence = 0;

/** A text event; long text is split into chunks to stream like the real API. */
export function say(text: string): ModelEvent[] {
  const chunks = text.match(/[\s\S]{1,40}/g) ?? [];
  return chunks.map((delta) => ({ type: "text" as const, delta }));
}

/** A finished tool call with a fresh tool_use id. */
export function toolUse(name: string, input: unknown, id = `toolu_scripted_${++toolSequence}`): ModelEvent {
  return { type: "tool_use", id, name, input };
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** Rough token count for scripted usage: four characters per token. */
function tokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/**
 * Simulated prompt-cache accounting with the API's rules: the cached prefix is tools, system, then
 * messages; a call reads whatever prefix an earlier call of this model wrote, and writes the rest.
 */
function cacheUsage(params: StreamParams, previous: StreamParams | undefined): Omit<Usage, "outputTokens"> {
  const stable = tokens(params.tools) + tokens(params.system);
  const total = stable + tokens(params.messages);
  if (!previous || JSON.stringify([previous.tools, previous.system]) !== JSON.stringify([params.tools, params.system])) {
    return { inputTokens: total, cacheReadInputTokens: 0, cacheCreationInputTokens: total };
  }
  const prior = previous.messages;
  const extends_ = prior.length <= params.messages.length && JSON.stringify(params.messages.slice(0, prior.length)) === JSON.stringify(prior);
  const read = stable + (extends_ ? tokens(prior) : 0);
  return { inputTokens: total, cacheReadInputTokens: read, cacheCreationInputTokens: total - read };
}

/** Replays `steps`, one per call. Usage includes simulated cache reads across the calls of one model. */
export function scriptedModel(steps: ScriptedStep[]): ScriptedModel {
  const queue = [...steps];
  const calls: StreamParams[] = [];
  return {
    calls,
    remaining: () => queue.length,
    async *stream(params) {
      calls.push(params);
      const step = queue.shift();
      if (!step) throw new Error(`The scripted model has no response for call ${calls.length}.`);
      const events = typeof step === "function" ? step(params, calls.length) : step;
      let sawStop = false;
      for (const event of events) {
        if (params.signal?.aborted) throw abortError();
        await Promise.resolve();
        if (event.type === "stop") sawStop = true;
        yield event;
      }
      if (!sawStop) {
        const toolCall = events.some((event) => event.type === "tool_use");
        yield {
          type: "stop",
          stopReason: toolCall ? "tool_use" : "end_turn",
          usage: { ...cacheUsage(params, calls.at(-2)), outputTokens: tokens(events) },
        };
      }
    },
  };
}
