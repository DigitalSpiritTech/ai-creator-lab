/**
 * Drives one job from submission to stored outputs: poll with backoff, then retrieve.
 * The serial per-target runner (B8) builds on this; it is also what the acceptance smoke uses.
 * @packageDocumentation
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Executor, PollOutcome, RetrieveDestination, RetrieveOutcome } from "@/server/executors/types";

export interface RunOptions {
  sleep?: (ms: number) => Promise<unknown>;
  /** Gives up (leaving the job as it is) after this long; the job stays recoverable. */
  timeoutMs?: number;
  now?: () => number;
}

export type RunOutcome = RetrieveOutcome | Extract<PollOutcome, { kind: "failed" | "uncertain" | "pending" }>;

/** Polls until the job is ready, then retrieves, retrying retrieval while the failure is retryable. */
export async function runToCompletion(executor: Executor, jobId: string, destination: RetrieveDestination, options: RunOptions = {}): Promise<RunOutcome> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 30 * 60_000);
  while (true) {
    const polled = await executor.poll(jobId);
    if (polled.kind === "failed") return polled;
    if (polled.kind === "ready" || polled.kind === "completed") {
      const retrieved = await executor.retrieve(jobId, destination);
      if (retrieved.kind !== "retry" && retrieved.kind !== "not_ready") return retrieved;
      if (now() + (retrieved.kind === "retry" ? retrieved.retryAfterMs : 0) > deadline) return retrieved;
      await sleep(retrieved.kind === "retry" ? retrieved.retryAfterMs : 1000);
      continue;
    }
    if (now() + polled.retryAfterMs > deadline) return polled;
    await sleep(polled.retryAfterMs);
  }
}
