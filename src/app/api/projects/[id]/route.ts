/**
 * One project's full state (`get_project_state`) plus what the workspace needs to group candidates:
 * the generation target of every asset's job, and the exports of each content piece.
 * @packageDocumentation
 */
import type { GenerationTarget } from "@/lib/domain/job";
import { callTool } from "@/server/tools";
import type { ProjectState } from "@/lib/client/types";
import { parseId, route, toolContextFor, unwrap, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const projectId = parseId((await params).id);
    return withStore(async (store) => {
      const state = unwrap<ProjectState>(await callTool(toolContextFor(store), "get_project_state", { projectId }));
      const targets: Record<string, GenerationTarget> = {};
      const recipes: Record<string, string> = {};
      for (const asset of state.assets) {
        if (asset.provenance.source !== "generated") continue;
        recipes[asset.id] = asset.provenance.recipeId;
        const job = store.jobs.get(asset.provenance.jobId);
        if (job) targets[asset.id] = job.request.target;
      }
      const exports = state.contents.flatMap((content) => store.content.listExports(content.id));
      const workspace = store.workspace.get();
      return Response.json({ ...state, targets, recipes, exports, autoApprove: workspace.autoApprove });
    });
  });
}
