/**
 * The typed tool shape shared by the in-app agent and (later) the MCP server: Zod input,
 * Zod output, and a `run` over the store. JSON schemas for tool use derive from the Zod input.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { Recipe } from "@/lib/catalog";
import { fail } from "@/lib/domain/failure";
import type { ExecutorSet } from "@/server/executors";
import type { Store } from "@/server/store";

/** What the generation tools need beyond the store: executors and the recipe catalog. */
export interface GenerationContext {
  executors: ExecutorSet;
  recipes(): Promise<Recipe[]>;
  /** Paid cap override in USD; defaults to the lower of the workspace setting and GENERATION_ALLOWANCE_USD. */
  allowanceUsd?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  poster?: (videoPath: string, posterPath: string) => Promise<void>;
}

export interface ToolContext {
  store: Store;
  now(): number;
  newId(): string;
  /** Absent in contexts that only read and edit; generation tools then fail with "invalid". */
  generation?: GenerationContext;
}

export function createToolContext(store: Store, generation?: GenerationContext): ToolContext {
  return { store, now: () => Date.now(), newId: () => randomUUID(), generation };
}

export function requireGeneration(context: ToolContext): GenerationContext {
  return context.generation ?? fail("invalid", "Generation is not configured for this session.");
}

export interface Tool {
  name: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  /** Receives input already parsed by `input`; returns a value `output` accepts. */
  run(context: ToolContext, input: unknown): Promise<unknown>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(definition: {
  name: string;
  description: string;
  input: I;
  output: O;
  run: (context: ToolContext, input: z.output<I>) => z.input<O> | Promise<z.input<O>>;
}): Tool {
  return {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    run: async (context, input) => definition.run(context, input as z.output<I>),
  };
}

/** Converts tools to the `tools` array of the Anthropic Messages API. */
export function toJsonSchemaTools(tools: readonly Tool[]): AnthropicTool[] {
  return tools.map((tool) => {
    const schema = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    if (schema.type !== "object") throw new Error(`Tool ${tool.name} must take an object input.`);
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema as AnthropicTool["input_schema"],
    };
  });
}
