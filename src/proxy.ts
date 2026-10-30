/**
 * Applies the local-only request policy before rendering pages or serving APIs, plus the hosted
 * modes: read-only refuses every request that could change something, judging requires the
 * password on every request.
 * Inputs: framework requests. Output: continuation or a rejected response.
 * Expected errors: none; policy failures become HTTP responses.
 * @packageDocumentation
 */
import { NextResponse, type NextRequest } from "next/server";
import { READ_ONLY_MESSAGE, READ_ONLY_METHODS, authorized, isReadOnly, judgePassword } from "@/server/demo";
import { assertLocalRequest, errorResponse } from "@/server/http";

export function proxy(request: NextRequest) {
  try {
    assertLocalRequest(request);
    if (isReadOnly() && !READ_ONLY_METHODS.has(request.method)) {
      return NextResponse.json({ error: READ_ONLY_MESSAGE }, { status: 403 });
    }
    const password = judgePassword();
    if (password && !authorized(request.headers.get("authorization"), password)) {
      return new NextResponse("This copy of AI Creator Lab is for invited judges. Enter the judging password.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="AI Creator Lab judging", charset="UTF-8"', "Cache-Control": "no-store" },
      });
    }
    return NextResponse.next();
  } catch (error) { return errorResponse(error); }
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
