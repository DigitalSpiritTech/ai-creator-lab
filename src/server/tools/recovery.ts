/**
 * Starts restart recovery once per process: every unfinished job is resumed in the background with
 * the shared generation context, one at a time. Skipped during `next build` and when
 * `STUDIO_RECOVERY=off`.
 * @packageDocumentation
 */
import { type StepOutcome, recoverAndDrain } from "@/server/executors/run";
import type { Store } from "@/server/store";
import { createGenerationContext } from "@/server/tools/generation-context";
import { runDeps } from "@/server/tools/proposals";
import { createToolContext } from "@/server/tools/registry";

const holder = globalThis as typeof globalThis & { __creatorLabRecovery?: WeakMap<Store, Promise<StepOutcome[]>> };

/** Whether recovery should run in this process. */
export function recoveryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXT_PHASE !== "phase-production-build" && env.STUDIO_RECOVERY !== "off";
}

/**
 * Resumes unfinished jobs for a store, once. Returns the same promise to every later caller; it never
 * rejects. Logs one line per job through `log` (console by default).
 */
export function startRecoveryOnce(store: Store, log: (line: string) => void = (line) => console.info(line)): Promise<StepOutcome[]> {
  const started = (holder.__creatorLabRecovery ??= new WeakMap());
  const existing = started.get(store);
  if (existing) return existing;
  const run = Promise.resolve()
    .then(() => recoverAndDrain(runDeps(createToolContext(store, createGenerationContext(store))), log))
    .catch((cause: unknown) => {
      log(`[recovery] stopped: ${cause instanceof Error ? cause.name : "error"}`);
      return [];
    });
  started.set(store, run);
  return run;
}
