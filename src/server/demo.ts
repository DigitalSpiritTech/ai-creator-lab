/**
 * Read-only demo mode. With `STUDIO_READ_ONLY=1` the app serves an existing data folder for
 * viewing only: every request that could change anything is refused before it reaches a route,
 * and `STUDIO_PUBLIC_HOST` (honored only in this mode) is the one hostname the local-only guard
 * accepts besides localhost, so the demo can sit behind a platform proxy without header rewriting.
 * Nothing here loosens spending: a demo server has no keys and no allowance.
 * @packageDocumentation
 */

export function isReadOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env.STUDIO_READ_ONLY === "1";
}

/** The public hostname of a read-only demo, lowercased; undefined outside read-only mode. */
export function publicHost(env: Record<string, string | undefined> = process.env): string | undefined {
  if (!isReadOnly(env)) return undefined;
  const host = env.STUDIO_PUBLIC_HOST?.trim().toLowerCase();
  return host || undefined;
}

export const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const READ_ONLY_MESSAGE = "This is a read-only demo: you can look at every project, asset and export, but nothing can be changed or generated here. Run AI Creator Lab on your own computer to make your own.";
