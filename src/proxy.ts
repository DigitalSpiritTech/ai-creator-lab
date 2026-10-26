/**
 * Applies the local-only request policy before rendering pages or serving APIs.
 * Inputs: framework requests. Output: continuation or a rejected response.
 * Expected errors: none; policy failures become HTTP responses.
 * @packageDocumentation
 */
import { NextResponse, type NextRequest } from "next/server";
import { assertLocalRequest, errorResponse } from "@/server/http";

/**
 * Checks host and origin before any private workspace data is rendered.
 * @param request - Framework request.
 * @returns Continuation for trusted local requests, otherwise an error response.
 * @throws No expected errors.
 */
export function proxy(request: NextRequest) {
  try {
    assertLocalRequest(request);
    return NextResponse.next();
  } catch (error) { return errorResponse(error); }
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
