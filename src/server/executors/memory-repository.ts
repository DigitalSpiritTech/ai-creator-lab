/**
 * In-memory job repository for tests and the credit-free mock flow.
 * @packageDocumentation
 */
import { JobRecordSchema, type JobRecord, type JobRepository } from "@/server/executors/types";

export class MemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();

  async get(id: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  async getByRequestId(requestId: string): Promise<JobRecord | undefined> {
    for (const job of this.jobs.values()) {
      if (job.requestId === requestId) return structuredClone(job);
    }
    return undefined;
  }

  async insert(job: JobRecord): Promise<{ inserted: boolean; job: JobRecord }> {
    const existing = await this.getByRequestId(job.requestId);
    if (existing) return { inserted: false, job: existing };
    if (this.jobs.has(job.id)) throw new Error("A job with this id already exists.");
    const parsed = JobRecordSchema.parse(job);
    this.jobs.set(parsed.id, structuredClone(parsed));
    return { inserted: true, job: structuredClone(parsed) };
  }

  async update(next: JobRecord, expectedRevision: number): Promise<JobRecord | undefined> {
    const current = this.jobs.get(next.id);
    if (!current || current.revision !== expectedRevision) return undefined;
    const parsed = JobRecordSchema.parse(next);
    this.jobs.set(parsed.id, structuredClone(parsed));
    return structuredClone(parsed);
  }

  /** Every stored job, oldest first. */
  all(): JobRecord[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }
}
