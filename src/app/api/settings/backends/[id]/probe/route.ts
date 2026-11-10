/**
 * Checks one backend again: reads its object_info (or Router's model list) and compares it with
 * every recipe. Free; nothing is submitted.
 * @packageDocumentation
 */
import { assertLocalRequest } from "@/server/http";
import { backendsView, parseBackendId, probeStored } from "@/app/api/_lib/backends";
import { route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    assertLocalRequest(request);
    const id = parseBackendId((await params).id);
    return withStore(async (store) => {
      const probed = await probeStored(store, id);
      return Response.json({ ...(await backendsView(store)), probed });
    });
  });
}
