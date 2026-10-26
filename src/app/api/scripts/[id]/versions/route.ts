/**
 * Every saved version of one script, oldest first, for the Script tab's history.
 * @packageDocumentation
 */
import { parseId, route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const scriptId = parseId((await params).id);
    return withStore((store) => {
      store.scripts.getRequired(scriptId);
      return Response.json({ versions: store.scripts.listVersions(scriptId) });
    });
  });
}
