/**
 * The app's auth entry points: the active provider, the paths that stay open without a session,
 * session cookies, and the setup-code notice for the server log.
 *
 * Who needs to sign in: nobody while the server listens on loopback only (the default). When it is
 * reachable from other machines (`HOST` or `STUDIO_ALLOWED_HOSTS`, see `network.ts`), every page
 * and API route needs a session except the sign-in page and its endpoints; static build files are
 * outside the proxy matcher. The read-only demo (`STUDIO_READ_ONLY=1`) stays public by design.
 * @packageDocumentation
 */
import { networkInterfaces } from "node:os";
import { dataDirectory } from "@/server/data-dir";
import { allowedHostsHint, isNetworkExposed, requestProtocol } from "@/server/auth/network";
import { hostedMode } from "@/server/demo";
import { type AuthProvider, SESSION_COOKIE, SESSION_DAYS, createSinglePasswordProvider } from "@/server/auth/provider";

export { SESSION_COOKIE } from "@/server/auth/provider";
export type { AuthProvider, Session, SignInResult } from "@/server/auth/provider";

export const SIGN_IN_PATH = "/login";

/** Request header the proxy sets on a signed-in request (and strips from the client's); the layout reads it to show Sign out. */
export const SESSION_HEADER = "x-creator-lab-session";

/** Paths reachable without a session: the sign-in page and its endpoints. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([SIGN_IN_PATH, "/api/auth/session", "/api/auth/login", "/api/auth/setup", "/api/auth/logout"]);

export function isPublicPath(pathname: string): boolean {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PUBLIC_PATHS.has(trimmed);
}

const holder = globalThis as typeof globalThis & { __creatorLabAuth?: AuthProvider };

/** The active provider. The single-password provider is the only one that ships. */
export function authProvider(): AuthProvider {
  holder.__creatorLabAuth ??= createSinglePasswordProvider({ dataDir: dataDirectory });
  return holder.__creatorLabAuth;
}

/** Replaces the active provider; for tests. Pass undefined to go back to the default. */
export function setAuthProvider(provider: AuthProvider | undefined): void {
  holder.__creatorLabAuth = provider;
}

export const SIGN_IN_MESSAGE = "Sign in to use this studio.";

/** The 401 an API route answers without a session; the client sends the person to `signIn`. */
export function signInRequired(): Response {
  return Response.json({ error: SIGN_IN_MESSAGE, signIn: SIGN_IN_PATH }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

/**
 * Refuses a request that needs a session and has none.
 * @throws A 401 Response.
 */
export function assertSignedIn(request: Request): void {
  const provider = authProvider();
  if (!provider.required(request)) return;
  if (isPublicPath(new URL(request.url).pathname)) return;
  if (!provider.authenticate(request)) throw signInRequired();
}

/** Whether the browser reached the app over https (directly, or through a named TLS proxy). */
export function isSecureRequest(request: Request): boolean {
  return requestProtocol(request) === "https:";
}

/** The Set-Cookie value for a new session: HttpOnly, SameSite=Strict, Secure over https. */
export function sessionCookie(token: string, request: Request): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${SESSION_DAYS * 86_400}`, ...(isSecureRequest(request) ? ["Secure"] : [])].join("; ");
}

export function clearedSessionCookie(request: Request): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", ...(isSecureRequest(request) ? ["Secure"] : [])].join("; ");
}

/** At server start: says in the log that the password is in force, or prints the setup code. */
export function announceAccess(log: (line: string) => void = console.log): void {
  if (hostedMode() || !isNetworkExposed()) return;
  if (authProvider().configured()) log("[auth] This studio is reachable from the network: every page and API call needs the app password.");
  else announceSetupCode(log);
  const hint = allowedHostsHint(process.env, localAddresses());
  if (hint) log(hint);
}

/** This machine's non-internal IPv4 addresses, for the startup hint. */
function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => !!entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry!.address);
}

/**
 * Issues a setup code if none is pending from this process and prints it to the server log. The
 * code is the proof that the person choosing the password can read this server's output, so a
 * stranger who reaches the port first cannot claim the studio.
 */
export function announceSetupCode(log: (line: string) => void = console.log): void {
  const code = authProvider().issueSetupCode();
  if (!code) return;
  log(
    [
      "",
      "[auth] This studio is reachable from the network and has no password yet.",
      `[auth] Open ${SIGN_IN_PATH} in a browser and enter this one-time setup code to choose one: ${code}`,
      "[auth] A new code is printed each time the server starts, until a password is set.",
      "",
    ].join("\n"),
  );
}
