/**
 * The spending gate: submits a proposal the user approved (or auto-approve accepted) through the
 * internal `submit_proposal` tool. Jobs then run in the background; poll the jobs route.
 * @packageDocumentation
 */
import { z } from "zod";
import { GenerationProposalSchema } from "@/lib/domain/job";
import { readJson } from "@/server/http";
import { callTool } from "@/server/tools";
import { parseId, route, toolContextFor, toolResponse, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

const SubmitBodySchema = z
  .object({
    proposal: GenerationProposalSchema,
    confirmUnquoted: z.boolean().default(false),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const projectId = parseId((await params).id);
    const body = SubmitBodySchema.parse(await readJson(request, 64 * 1024));
    if (body.proposal.projectId !== projectId) {
      return Response.json({ error: "This proposal belongs to another project." }, { status: 400 });
    }
    return withStore(async (store) =>
      toolResponse(
        await callTool(toolContextFor(store), "submit_proposal", {
          proposal: body.proposal,
          confirmUnquoted: body.confirmUnquoted,
          wait: false,
        }),
      ),
    );
  });
}
