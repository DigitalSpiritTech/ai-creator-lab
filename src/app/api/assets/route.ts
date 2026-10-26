/**
 * Lists assets (`list_assets`) for the Assets and Archive pages, filtered by project, kind, state,
 * and recipe.
 * @packageDocumentation
 */
import { z } from "zod";
import { AssetKindSchema } from "@/lib/domain/asset";
import { IdSchema, RecipeIdSchema } from "@/lib/domain/common";
import { callTool } from "@/server/tools";
import { parseQuery, route, toolContextFor, toolResponse, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  projectId: IdSchema.optional(),
  kind: AssetKindSchema.optional(),
  state: z.enum(["active", "archived", "any"]).default("active"),
  recipeId: RecipeIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    const query = parseQuery(request, QuerySchema);
    return withStore(async (store) => toolResponse(await callTool(toolContextFor(store), "list_assets", query)));
  });
}
