/**
 * The project chat. GET returns the stored conversation; POST streams one assistant turn as
 * server-sent events (`event: <type>` with the AgentEvent as JSON data). Closing the request aborts
 * the turn. The provider (Anthropic, or Comfy Router with the Comfy key), its key, and the model come
 * from the environment, then Settings.
 * @packageDocumentation
 */
import { z } from "zod";
import { type AgentEvent, assistantModel, runAgentTurn } from "@/server/agent";
import { readSecrets } from "@/server/secrets";
import { conversationsOf } from "@/server/store/conversations";
import { encodeSse } from "@/lib/client/sse";
import { readJson } from "@/server/http";
import { getStore, parseId, route, toolContextFor, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

const ChatBodySchema = z.object({ message: z.string().trim().min(1).max(8000) }).strict();

/** How many stored messages the chat panel reloads. */
const HISTORY_LIMIT = 200;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const projectId = parseId((await params).id);
    return withStore((store) => {
      store.projects.getRequired(projectId);
      return Response.json({ messages: conversationsOf(store).listByProject(projectId, { limit: HISTORY_LIMIT }) });
    });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const projectId = parseId((await params).id);
    const { message } = ChatBodySchema.parse(await readJson(request, 32 * 1024));
    await withStore((store) => store.projects.getRequired(projectId));
    const store = getStore();
    const context = toolContextFor(store);
    const model = assistantModel(readSecrets(store.dataDir));
    const encoder = new TextEncoder();
    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort());
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: AgentEvent) => controller.enqueue(encoder.encode(encodeSse(event)));
        try {
          for await (const event of runAgentTurn(context, { projectId, userMessage: message }, { signal: abort.signal, model })) {
            if (abort.signal.aborted) break;
            send(event);
          }
        } catch {
          if (!abort.signal.aborted) send({ type: "error", message: "The assistant stopped unexpectedly. Try again." });
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed because the client went away.
          }
        }
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
