/**
 * Runs one roster tool for a project (`callTool`). The spending gate is a separate route.
 * @packageDocumentation
 */
import { parseId, route, runToolRequest } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; name: string }> }): Promise<Response> {
  return route(async () => {
    const { id, name } = await params;
    return runToolRequest(request, name, parseId(id));
  });
}
