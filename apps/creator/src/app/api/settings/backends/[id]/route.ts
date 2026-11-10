/**
 * One backend: PUT renames it or makes it the default for workflows; DELETE removes a backend a
 * person added (built-ins stay, and a backend with generations in flight stays until they finish).
 * @packageDocumentation
 */
import { UpdateBackendSchema } from "@creator-lab/core/catalog";
import { removeBackend, updateBackend } from "@/server/catalog/backends";
import { assertLocalRequest, readJson } from "@/server/http";
import { backendsView, parseBackendId } from "@/app/api/_lib/backends";
import { route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const id = parseBackendId((await params).id);
    const patch = UpdateBackendSchema.parse(await readJson(request));
    return withStore(async (store) => {
      updateBackend(store, id, patch);
      return Response.json(await backendsView(store));
    });
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    assertLocalRequest(request);
    const id = parseBackendId((await params).id);
    return withStore(async (store) => {
      removeBackend(store, id);
      return Response.json(await backendsView(store));
    });
  });
}
