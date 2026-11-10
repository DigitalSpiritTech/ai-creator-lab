/**
 * HTTP contracts for signing in to a studio that is reachable from the network: the session
 * status, first-run setup, sign-in, and sign-out. Passwords travel in request bodies only and are
 * never part of any response.
 * @packageDocumentation
 */
import { z } from "zod";

export const AUTH_PASSWORD_MIN_LENGTH = 12;
export const AUTH_PASSWORD_MAX_LENGTH = 200;

const Password = z
  .string()
  .min(AUTH_PASSWORD_MIN_LENGTH, `Use at least ${AUTH_PASSWORD_MIN_LENGTH} characters.`)
  .max(AUTH_PASSWORD_MAX_LENGTH, `Use at most ${AUTH_PASSWORD_MAX_LENGTH} characters.`);

/** `GET /api/auth/session`. */
export const AuthStatusSchema = z.object({
  /** Whether this server asks for the app password (it is reachable from the network). */
  required: z.boolean(),
  /** Whether a password has been set. */
  configured: z.boolean(),
  authenticated: z.boolean(),
  readOnly: z.boolean(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

/** `POST /api/auth/setup`: the one-time code from the server log, and the new password. */
export const AuthSetupRequestSchema = z
  .object({
    setupCode: z.string().trim().min(1, "Enter the setup code from the server log.").max(64),
    password: Password,
  })
  .strict();
export type AuthSetupRequest = z.infer<typeof AuthSetupRequestSchema>;

/** `POST /api/auth/login`. Length is not checked here so a wrong password reads as wrong, not as a format error. */
export const AuthLoginRequestSchema = z.object({ password: z.string().min(1, "Enter the password.").max(AUTH_PASSWORD_MAX_LENGTH) }).strict();
export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;

/**
 * Where to go after signing in: a path on this site only. Control characters and backslashes are
 * refused outright (browsers strip tabs and newlines, so `/\t/host` would become `//host`), and the
 * result is re-parsed against a fixed origin so nothing can resolve to another host.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || /[\u0000-\u001F\u007F\\]/.test(value)) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) return "/";
  const base = "http://studio.invalid";
  try {
    const url = new URL(value, base);
    const out = url.pathname + url.search + url.hash;
    // Normalization can turn `/.//host` into `//host`, so the output is checked as well as the input.
    if (url.origin !== base || url.pathname.startsWith("/login") || !out.startsWith("/") || out.startsWith("//") || out.startsWith("/\\")) return "/";
    return out;
  } catch {
    return "/";
  }
}
