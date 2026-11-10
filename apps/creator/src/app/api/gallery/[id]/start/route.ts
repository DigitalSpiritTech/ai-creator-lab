/**
 * "Start from this example", first half: puts the example's characters, products, and sets into
 * this Library (reusing items of the same kind and name) and returns the inbound context, the App,
 * and the panel to open. The page then creates the project with `POST /api/projects` and that
 * `inbound`, which saves the brief as version 1 and links the items in one transaction.
 * @packageDocumentation
 */
import { ExampleIdSchema } from "@creator-lab/core/domain/gallery";
import { serverPlugins } from "@/plugins/server";
import { assertLocalRequest } from "@/server/http";
import { loadExample, prepareExampleInbound } from "@/server/gallery";
import { route, toolContextFor, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    // A write (it can add Library items): the same host, origin, read-only, and sign-in rules as every route.
    assertLocalRequest(request);
    const id = ExampleIdSchema.safeParse((await params).id);
    if (!id.success) return Response.json({ error: "There is no such example in the gallery." }, { status: 404 });
    const example = await loadExample(id.data);
    return withStore((store) => {
      const { inbound, created, reused } = prepareExampleInbound(toolContextFor(store, "user", request), example);
      const type = serverPlugins.contentTypeForApp(example.appId);
      const panel = type?.modes.find((mode) => mode.id === example.mode)?.panel ?? null;
      return Response.json({ name: example.title.slice(0, 80), appId: example.appId, inbound, panel, created, reused });
    });
  });
}
