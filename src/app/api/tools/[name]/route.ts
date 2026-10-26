/**
 * Runs one roster tool outside a project: Library, Assets, and Archive pages use it.
 * @packageDocumentation
 */
import { route, runToolRequest } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  return route(async () => runToolRequest(request, (await params).name));
}
