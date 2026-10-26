/**
 * In-memory `JobStorePort` for executor tests, with the same rules as `store.jobs`: one job per
 * requestId, optimistic revisions, terminal states final, and no completion outside the commit.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import type { Recipe } from "@/lib/catalog";
import {
  type GenerationInput,
  type GenerationTarget,
  type Job,
  JobSchema,
  type JobStorePort,
  createJob,
  isTerminal,
} from "@/lib/domain/job";

export const TEST_PROJECT_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

export class MemoryJobStore implements JobStorePort {
  private readonly jobs = new Map<string, Job>();

  add(job: Job): { job: Job; created: boolean } {
    const existing = this.getByRequest(job.requestId);
    if (existing) return { job: existing, created: false };
    if (this.jobs.has(job.id)) throw new Error("A job with this id already exists.");
    const parsed = JobSchema.parse(job);
    this.jobs.set(parsed.id, structuredClone(parsed));
    return { job: structuredClone(parsed), created: true };
  }

  get(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  getByRequest(requestId: string): Job | undefined {
    for (const job of this.jobs.values()) if (job.requestId === requestId) return structuredClone(job);
    return undefined;
  }

  listUnfinished(): Job[] {
    return this.all().filter((job) => !isTerminal(job));
  }

  transition(previous: Job, next: Job): boolean {
    const current = this.jobs.get(previous.id);
    if (!current || current.revision !== previous.revision || isTerminal(current)) return false;
    if (next.id !== previous.id || next.revision !== previous.revision + 1) throw new Error("Bad transition.");
    if (next.status === "completed") throw new Error("Complete a job through the output commit.");
    this.jobs.set(next.id, structuredClone(JobSchema.parse(next)));
    return true;
  }

  /** Test hook: replaces a stored job as another worker would. */
  put(job: Job): void {
    this.jobs.set(job.id, structuredClone(JobSchema.parse(job)));
  }

  all(): Job[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }
}

/** Admits a job for a request as the run orchestration does, returning it in `queued`. */
export function admitJob(
  jobs: JobStorePort,
  request: { recipe: Recipe; input: Partial<GenerationInput> & { prompt: string }; requestId?: string; target?: GenerationTarget },
  now = Date.now(),
): Job {
  const job = createJob(
    {
      id: randomUUID(),
      requestId: request.requestId ?? randomUUID(),
      projectId: TEST_PROJECT_ID,
      request: { recipe: request.recipe, input: { images: [], ...request.input }, target: request.target },
    },
    now,
  );
  return jobs.add(job).job;
}
