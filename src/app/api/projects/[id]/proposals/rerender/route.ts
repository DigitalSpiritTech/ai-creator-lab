/**
 * The proposal card's recipe selector: the same proposal for another recipe (`rerender_proposal`),
 * with the prompt rendered in that model's style and the estimate made on the server. Nothing runs.
 * @packageDocumentation
 */
import { z } from "zod";
import { RecipeIdSchema } from "@/lib/domain/common";
import { GenerationProposalSchema } from "@/lib/domain/job";
import { readJson } from "@/server/http";
import { callTool } from "@/server/tools";
import { parseId, route, toolContextFor, toolResponse, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

const RerenderBodySchema = z
  .object({
    proposal: GenerationProposalSchema,
    recipeId: RecipeIdSchema,
    count: z.number().int().min(1).max(4).optional(),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const projectId = parseId((await params).id);
    const body = RerenderBodySchema.parse(await readJson(request, 64 * 1024));
    if (body.proposal.projectId !== projectId) {
      return Response.json({ error: "This proposal belongs to another project." }, { status: 400 });
    }
    return withStore(async (store) => toolResponse(await callTool(toolContextFor(store), "rerender_proposal", body)));
  });
}
