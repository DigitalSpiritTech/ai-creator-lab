/**
 * A scripted {@link LlmModel} that replays recorded model responses, for offline tests, evals, and
 * demos without an Anthropic key. Each `stream` call plays the next step and records its params.
 * @packageDocumentation
 */
import type { LlmModel, ModelEvent, StreamParams } from "@/server/agent/model";

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
export function use(name: string, input: unknown, id = `toolu_scripted_${++toolSequence}`): ModelEvent {
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
          usage: { inputTokens: tokens(params.system) + tokens(params.messages), outputTokens: tokens(events) },
        };
      }
    },
  };
}
