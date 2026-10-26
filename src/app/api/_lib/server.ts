/**
 * Shared plumbing for API route handlers: the tool context over the process store, tool results as
 * HTTP responses, and route parameter validation. Every handler runs inside `route`, which formats
 * failures with `errorResponse` so no stack, path, or key reaches the client.
 * @packageDocumentation
 */
import "server-only";
import { z } from "zod";
import { IdSchema } from "@/lib/domain/common";
import { errorResponse, readJson } from "@/server/http";
import { getStore, withStore } from "@/server/runtime";
import { readSecrets } from "@/server/secrets";
import type { Store } from "@/server/store";
import {
  type GenerationContext,
  type ToolContext,
  TOOLS,
  type ToolResult,
  callTool,
  createGenerationContext,
  createToolContext,
} from "@/server/tools";


type Cached = { store: Store; key: string | undefined; generation: GenerationContext };
const holder = globalThis as typeof globalThis & { __creatorLabGeneration?: Cached };

/**
 * The generation context for the process store, rebuilt when the store or the Comfy key changes
 * (for example after the key is saved in Settings).
 */
export function generationFor(store: Store): GenerationContext {
  const key = readSecrets(store.dataDir).comfyApiKey;
  const cached = holder.__creatorLabGeneration;
  if (cached && cached.store === store && cached.key === key) return cached.generation;
  const generation = createGenerationContext(store);
  holder.__creatorLabGeneration = { store, key, generation };
  return generation;
}

export function toolContextFor(store: Store): ToolContext {
  return createToolContext(store, generationFor(store));
}

/** Runs a handler and turns thrown Responses, Zod errors, and service failures into safe responses. */
export async function route(handler: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}

/** A tool result as JSON, or the failure as an error response. */
export function toolResponse(result: ToolResult, status = 200): Response {
  if (result.ok) return Response.json(result.output, { status });
  return errorResponse(result.failure);
}

/** Unwraps a tool result or throws its failure for `route` to format. */
export function unwrap<T>(result: ToolResult): T {
  if (!result.ok) throw result.failure;
  return result.output as T;
}

export function parseId(value: string): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw Response.json({ error: "This link is not valid." }, { status: 404 });
  return parsed.data;
}

/** Parses query parameters with a schema; empty strings count as absent. */
export function parseQuery<T extends z.ZodType>(request: Request, schema: T): z.output<T> {
  const entries = [...new URL(request.url).searchParams.entries()].filter(([, value]) => value !== "");
  return schema.parse(Object.fromEntries(entries));
}

export { getStore, withStore };

/**
 * Runs one roster tool with a JSON body. Internal tools (the spending gate) are not reachable here.
 * With `projectId`, an input that names a different project is refused.
 */
export async function runToolRequest(request: Request, name: string, projectId?: string): Promise<Response> {
  if (!TOOLS.some((tool) => tool.name === name)) return Response.json({ error: "There is no such tool." }, { status: 404 });
  const body = await readJson(request, 64 * 1024);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Send the tool input as a JSON object." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (projectId && input.projectId !== undefined && input.projectId !== projectId) {
    return Response.json({ error: "This input belongs to another project." }, { status: 400 });
  }
  return withStore(async (store) => toolResponse(await callTool(toolContextFor(store), name, input)));
}
