/**
 * The read-only flag and the two hosted modes. Your own studio on a network uses the app password
 * instead (`@/server/auth`); these modes sit outside it.
 *
 * Read-only (`STUDIO_READ_ONLY=1`, the official flag, on any bind): the data folder for viewing.
 * Every request that could change anything is refused by the proxy and again in the route. It is
 * public by design and never asks for the app password. The hosted demo also holds no keys.
 *
 * Judging (`STUDIO_JUDGE_PASSWORD=<secret>`, or `STUDIO_JUDGE_OPEN=1` for no password): a copy
 * where invited people, or anyone with the link, can run generations on the operator's account.
 * With a password every request needs it (HTTP basic auth). Either way the operator's allowance
 * (`GENERATION_ALLOWANCE_USD` plus the workspace allowance) is the hard stop on spend, as always.
 *
 * In either mode `STUDIO_PUBLIC_HOST` is a hostname the host guard accepts besides localhost, so
 * the app can sit behind a platform proxy without header rewriting. Outside these modes the
 * variable does nothing; `STUDIO_ALLOWED_HOSTS` is the general list (see `@/server/auth/network`).
 * @packageDocumentation
 */

import { createHash, timingSafeEqual } from "node:crypto";

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

/**
 * Whether an Authorization header carries the judging password (any user name). Compares SHA-256
 * digests with `timingSafeEqual`, so the time taken says nothing about the length or the content.
 */
export function authorized(header: string | null, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
  const given = decoded.slice(decoded.indexOf(":") + 1);
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(given), digest(password));
}
