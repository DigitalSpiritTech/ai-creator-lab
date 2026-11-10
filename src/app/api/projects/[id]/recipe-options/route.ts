/**
 * What the proposal card's recipe selector lists (`recipe_options`): recipes available on the
 * configured backends for a capability and reference count, or for the job behind a candidate.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema } from "@/lib/domain/capability";
import { IdSchema } from "@/lib/domain/common";
import { callTool } from "@/server/tools";
import { parseId, parseQuery, route, toolContextFor, toolResponse, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  capability: CapabilitySchema.optional(),
  references: z.coerce.number().int().min(0).max(16).optional(),
  assetId: IdSchema.optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const projectId = parseId((await params).id);
    const query = parseQuery(request, QuerySchema);
    return withStore(async (store) => toolResponse(await callTool(toolContextFor(store), "recipe_options", { projectId, ...query })));
  });
}
