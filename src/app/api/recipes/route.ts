/**
 * Lists recipes (`list_recipes`), optionally for one capability.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema } from "@/lib/domain/capability";
import { callTool } from "@/server/tools";
import { parseQuery, route, toolContextFor, toolResponse, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({ capability: CapabilitySchema.optional() });

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    const query = parseQuery(request, QuerySchema);
    return withStore(async (store) => toolResponse(await callTool(toolContextFor(store), "list_recipes", query)));
  });
}
