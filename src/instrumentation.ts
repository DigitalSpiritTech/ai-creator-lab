/**
 * Next.js startup hook. In the Node runtime it opens the store, which resumes every unfinished
 * generation job in the background (see `startRecoveryOnce`), so a restart never strands a job.
 * @packageDocumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recoveryEnabled } = await import("@/server/tools/recovery");
  if (!recoveryEnabled()) return;
  const { getStore } = await import("@/server/runtime");
  getStore();
}
