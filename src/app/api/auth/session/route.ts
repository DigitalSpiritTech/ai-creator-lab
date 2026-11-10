/**
 * Whether this studio asks for the app password and whether this browser is signed in. Reachable
 * without a session, so it does not say whether a password has been set (the sign-in page decides
 * that on the server). When a password is needed and none is set yet, this also makes sure a setup
 * code is printed to the server log.
 * @packageDocumentation
 */
import { announceSetupCode, authProvider } from "@/server/auth";
import { authStatus } from "@/server/auth/responses";
import { assertLocalRequest, errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  try {
    assertLocalRequest(request);
    const status = authStatus(request);
    if (status.required && !authProvider().configured()) announceSetupCode();
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
