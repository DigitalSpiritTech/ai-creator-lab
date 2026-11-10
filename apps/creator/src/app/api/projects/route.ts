/**
 * Projects: list them, or create one in an installed App (`startProject`): an unknown App is a 400,
 * a parent must exist and belong to the same owner, and an `inbound` context seeds the brief and
 * links Library items in the same transaction.
 * @packageDocumentation
 */
import { readJson } from "@/server/http";
import { type StartProject, startProject } from "@/server/tools/project";
import { route, toolContextFor, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return route(() =>
    withStore((store) => {
      const projects = store.projects.list().map((project) => ({
        ...project,
        assetCount: store.assets.list({ projectId: project.id, limit: 500 }).length,
      }));
      return Response.json({ projects });
    }),
  );
}

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const input = await readJson(request);
    return withStore((store) => {
      // startProject parses the body; a malformed one is a 400 with the first problem.
      const { project, links } = startProject(toolContextFor(store, "user", request), input as StartProject);
      return Response.json({ project, links }, { status: 201 });
    });
  });
}
