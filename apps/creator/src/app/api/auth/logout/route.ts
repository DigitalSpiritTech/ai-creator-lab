/**
 * Signs this browser out: ends its session on the server and clears the cookie.
 * @packageDocumentation
 */
import { authProvider, clearedSessionCookie } from "@/server/auth";
import { assertLocalRequest, errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

export function POST(request: Request): Response {
  try {
    assertLocalRequest(request);
    authProvider().signOut(request);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": clearedSessionCookie(request) } });
  } catch (error) {
    return errorResponse(error);
  }
}
