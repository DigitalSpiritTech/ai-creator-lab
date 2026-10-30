/**
 * The two hosted modes. Neither is for running your own studio; the app is meant for your own
 * computer, where it listens on 127.0.0.1 only.
 *
 * Read-only demo (`STUDIO_READ_ONLY=1`): an existing data folder for viewing. Every request that
 * could change anything is refused before it reaches a route, and the server holds no keys.
 *
 * Judging (`STUDIO_JUDGE_PASSWORD=<secret>`, or `STUDIO_JUDGE_OPEN=1` for no password): a copy
 * where invited people, or anyone with the link, can run generations on the operator's account.
 * With a password every request needs it (HTTP basic auth). Either way the operator's allowance
 * (`GENERATION_ALLOWANCE_USD` plus the workspace allowance) is the hard stop on spend, as always.
 *
 * In either mode `STUDIO_PUBLIC_HOST` is the one hostname the local-only guard accepts besides
 * localhost, so the app can sit behind a platform proxy without header rewriting. Outside these
 * modes the variable does nothing.
 * @packageDocumentation
 */

type Env = Record<string, string | undefined>;

export function isReadOnly(env: Env = process.env): boolean {
  return env.STUDIO_READ_ONLY === "1";
}

/** The judging password when judging mode is on (at least 12 characters); undefined otherwise. */
export function judgePassword(env: Env = process.env): string | undefined {
  const password = env.STUDIO_JUDGE_PASSWORD?.trim();
  return password && password.length >= 12 ? password : undefined;
}

/** Judging without a password (`STUDIO_JUDGE_OPEN=1`): anyone with the link can run under the allowance. */
export function isJudgeOpen(env: Env = process.env): boolean {
  return env.STUDIO_JUDGE_OPEN === "1";
}

export function isJudging(env: Env = process.env): boolean {
  return !isReadOnly(env) && (judgePassword(env) !== undefined || isJudgeOpen(env));
}

export type HostedMode = "read-only" | "judging" | null;

export function hostedMode(env: Env = process.env): HostedMode {
  return isReadOnly(env) ? "read-only" : isJudging(env) ? "judging" : null;
}

/** The public hostname of a hosted copy, lowercased; undefined outside the hosted modes. */
export function publicHost(env: Env = process.env): string | undefined {
  if (!hostedMode(env)) return undefined;
  const host = env.STUDIO_PUBLIC_HOST?.trim().toLowerCase();
  return host || undefined;
}

export const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const READ_ONLY_MESSAGE = "This is a read-only demo: you can look at every project, asset and export, but nothing can be changed or generated here. Run AI Creator Lab on your own computer to make your own.";

/** Whether an Authorization header carries the judging password (any user name). Constant-time compare. */
export function authorized(header: string | null, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const given = decoded.slice(decoded.indexOf(":") + 1);
  if (given.length !== password.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ password.charCodeAt(i);
  return diff === 0;
}
