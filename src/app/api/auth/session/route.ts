/**
 * Whether this studio asks for the app password, whether one is set, and whether this browser is
 * signed in. Reachable without a session. When a password is needed and none is set yet, this
 * also makes sure a setup code is printed to the server log.
 * @packageDocumentation
 */
import { announceSetupCode } from "@/server/auth";
import { authStatus } from "@/server/auth/responses";
import { assertLocalRequest, errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  try {
    assertLocalRequest(request);
    const status = authStatus(request);
    if (status.required && !status.configured) announceSetupCode();
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
