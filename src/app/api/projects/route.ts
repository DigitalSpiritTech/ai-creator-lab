/**
 * Projects: list them, or create one from the UGC Creator App.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import { CreateProjectSchema, createProject } from "@/lib/domain/project";
import { readJson } from "@/server/http";
import { route, withStore } from "@/app/api/_lib/server";

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
    const input = CreateProjectSchema.parse(await readJson(request));
    return withStore((store) => {
      const project = store.projects.create(createProject(input, randomUUID(), Date.now()));
      return Response.json({ project }, { status: 201 });
    });
  });
}
