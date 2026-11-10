/**
 * Shared plumbing for API route handlers: the tool context over the process store, tool results as
 * HTTP responses, and route parameter validation. Every handler runs inside `route`, which formats
 * failures with `errorResponse` so no stack, path, or key reaches the client.
 * @packageDocumentation
 */
import "server-only";
import { z } from "zod";
import { IdSchema } from "@creator-lab/core/domain/common";
import { GenerationProposalSchema } from "@creator-lab/core/domain/job";
import type { DocumentAuthor } from "@creator-lab/core/domain/document";
import { errorResponse, readJson } from "@/server/http";
import { requestOwner } from "@/server/owner";
import { getStore, withStore } from "@/server/runtime";
import { readSecrets } from "@/server/secrets";
import type { Store } from "@/server/store";
import {
  type GenerationContext,
  type ToolContext,
  type ToolResult,
  callTool,
  createGenerationContext,
  createToolContext,
  isRosterTool,
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

/** A tool context for a route; pass the request so the context carries the owner it acts for. */
export function toolContextFor(store: Store, author: DocumentAuthor = "user", request?: Request): ToolContext {
  return createToolContext(store, generationFor(store), author, requestOwner(request));
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
 * The project a tool input's content piece belongs to: `contentId` (an Ad or a plugin piece), or a
 * piece document's `subjectId`. Undefined when the input names none, or one that does not exist
 * (the tool then reports it).
 */
export function projectOfInput(store: Store, input: Record<string, unknown>): string | undefined {
  const contentId = typeof input.contentId === "string" ? input.contentId : undefined;
  if (contentId) return store.content.get(contentId)?.projectId ?? store.pieces.get(contentId)?.projectId;
  if (input.kind === "piece" && typeof input.subjectId === "string") return store.pieces.get(input.subjectId)?.projectId;
  return undefined;
}

/**
 * Runs one roster tool with a JSON body. Internal tools (the spending gate) are not reachable here.
 * With `projectId`, an input that names a different project is refused.
 */
export async function runToolRequest(request: Request, name: string, projectId?: string): Promise<Response> {
  if (!isRosterTool(name)) return Response.json({ error: "There is no such tool." }, { status: 404 });
  const body = await readJson(request, 64 * 1024);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Send the tool input as a JSON object." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (projectId && input.projectId !== undefined && input.projectId !== projectId) {
    return Response.json({ error: "This input belongs to another project." }, { status: 400 });
  }
  return withStore(async (store) => {
    // A tool that names only a content piece (compose_still, approve, a plugin's tools) is held to
    // the piece's project, so one project's page cannot change another's pieces.
    const named = projectOfInput(store, input);
    if (projectId && named && named !== projectId) {
      return Response.json({ error: "This input belongs to another project." }, { status: 400 });
    }
    const result = await callTool(toolContextFor(store, "user", request), name, input);
    // A tool that finds its project from an asset (regenerate_with, refine_still) must not hand this
    // project's page a proposal for another project.
    if (projectId && result.ok) {
      const proposal = GenerationProposalSchema.safeParse(result.output);
      if (proposal.success && proposal.data.projectId !== projectId) return Response.json({ error: "This asset belongs to another project." }, { status: 400 });
    }
    return toolResponse(result);
  });
}
