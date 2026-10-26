/**
 * Unfinished jobs for a project. Each poll nudges stalled jobs (no update for a while, for example
 * after a restart) one step with `advanceGeneration`, in the background: the response never waits
 * on a provider, and a job already being nudged is left alone.
 * @packageDocumentation
 */
import { isTerminal } from "@/lib/domain/job";
import { advanceGeneration } from "@/server/executors/run";
import { runDeps } from "@/server/tools/proposals";
import { parseId, route, toolContextFor, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

/** A job untouched for this long is advanced by the poll. */
const STALLED_MS = 15_000;
/** Finished jobs reported back to the UI for this long. */
const RECENT_MS = 5 * 60_000;

const holder = globalThis as typeof globalThis & { __creatorLabNudging?: Set<string> };
const nudging = (holder.__creatorLabNudging ??= new Set<string>());

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const projectId = parseId((await params).id);
    return withStore(async (store) => {
      store.projects.getRequired(projectId);
      const now = Date.now();
      const deps = runDeps(toolContextFor(store));
      for (const job of store.jobs.listByProject(projectId)) {
        if (isTerminal(job) || now - job.updatedAt < STALLED_MS || nudging.has(job.id)) continue;
        nudging.add(job.id);
        void advanceGeneration(deps, job.id)
          .catch(() => undefined)
          .finally(() => nudging.delete(job.id));
      }
      const jobs = store.jobs.listByProject(projectId);
      return Response.json({
        unfinished: jobs.filter((job) => !isTerminal(job)),
        recent: jobs.filter((job) => isTerminal(job) && now - job.updatedAt < RECENT_MS),
      });
    });
  });
}
