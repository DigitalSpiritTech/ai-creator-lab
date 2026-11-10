/**
 * Backends: GET lists every backend with per-recipe status; POST adds a self-hosted ComfyUI or a
 * Comfy API deployment and probes it at once (object_info, free, nothing submitted). This is a
 * person's click in Settings; the assistant and the MCP server have no tool that adds a backend.
 * @packageDocumentation
 */
import { NewBackendSchema } from "@/lib/catalog";
import { addBackend } from "@/server/catalog/backends";
import { readJson } from "@/server/http";
import { backendsView, probeStored } from "@/app/api/_lib/backends";
import { route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return route(() => withStore(async (store) => Response.json(await backendsView(store))));
}

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const input = NewBackendSchema.parse(await readJson(request));
    return withStore(async (store) => {
      const added = addBackend(store, input);
      const probed = await probeStored(store, added.id);
      return Response.json({ ...(await backendsView(store)), added: probed }, { status: 201 });
    });
  });
}
