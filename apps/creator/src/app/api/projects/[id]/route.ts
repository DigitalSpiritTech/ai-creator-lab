/**
 * One project's full state (`get_project_state`) plus what the workspace needs to group candidates:
 * the generation target of every asset's job, and the exports of each content piece. PATCH moves the
 * project under another parent project.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, RevisionSchema } from "@creator-lab/core/domain/common";
import type { GenerationTarget } from "@creator-lab/core/domain/job";
import { readJson } from "@/server/http";
import { callTool } from "@/server/tools";
import { moveProject } from "@/server/tools/project";
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

const MoveSchema = z
  .object({ parentProjectId: IdSchema.nullable(), revision: RevisionSchema.optional() })
  .strict();

/** Moves the project under another parent project, or to the top with `parentProjectId: null`. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const projectId = parseId((await params).id);
    const input = MoveSchema.parse(await readJson(request));
    return withStore((store) => {
      const project = moveProject(toolContextFor(store, "user", request), projectId, input.parentProjectId, input.revision);
      return Response.json({ project });
    });
  });
}
