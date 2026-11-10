/**
 * Shared answers for the sign-in endpoints: a sign-in result as an HTTP response, with the session
 * cookie on success. The token goes into Set-Cookie only, never into a body or a log.
 * @packageDocumentation
 */
import { type SignInResult, authProvider, sessionCookie } from "@/server/auth";
import type { AuthStatus } from "@/lib/domain/auth";
import { isReadOnly } from "@/server/demo";

const NO_STORE = { "Cache-Control": "no-store" };

export function signInResponse(result: SignInResult, request: Request): Response {
  if (result.ok) {
    return Response.json({ ok: true }, { headers: { ...NO_STORE, "Set-Cookie": sessionCookie(result.token, request) } });
  }
  if (result.reason === "rate_limited") {
    return Response.json({ error: result.message }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(result.retryAfterSeconds) } });
  }
  return Response.json({ error: result.message }, { status: result.reason === "invalid" ? 401 : 409, headers: NO_STORE });
}

export function notNeededResponse(): Response {
  return Response.json({ error: "This studio does not ask for a password while it listens on this computer only." }, { status: 404, headers: NO_STORE });
}

export function authStatus(request: Request): AuthStatus {
  const provider = authProvider();
  const required = provider.required(request);
  return {
    required,
    configured: provider.configured(),
    authenticated: required ? provider.authenticate(request) !== null : false,
    readOnly: isReadOnly(),
  };
}
