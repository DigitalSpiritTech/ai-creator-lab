/**
 * Next.js startup hook. In the Node runtime it says in the log whether the app password is in
 * force (printing the one-time setup code on a first network start), then opens the store, which
 * resumes every unfinished generation job in the background (see `startRecoveryOnce`), so a
 * restart never strands a job.
 * @packageDocumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { announceAccess } = await import("@/server/auth");
  announceAccess();
  const { recoveryEnabled } = await import("@/server/tools/recovery");
  if (!recoveryEnabled()) return;
  const { getStore } = await import("@/server/runtime");
  getStore();
}
