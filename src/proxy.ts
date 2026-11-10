/**
 * The request policy for every page and API route, before anything renders: trusted host and
 * origin; the read-only flag refuses anything that could change something; the judging copy asks
 * for its password; and when the server is reachable from the network, the app password: an API
 * request without a session gets a 401, a page is sent to the sign-in page.
 * Inputs: framework requests. Output: continuation or a rejected response.
 * Expected errors: none; policy failures become HTTP responses.
 * @packageDocumentation
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_HEADER, SIGN_IN_PATH, authProvider, isPublicPath, signInRequired } from "@/server/auth";
import { READ_ONLY_MESSAGE, READ_ONLY_METHODS, authorized, isReadOnly, judgePassword } from "@/server/demo";
import { requestProtocol } from "@/server/auth/network";
import { assertTrustedOrigin, errorResponse } from "@/server/http";

export function proxy(request: NextRequest) {
  try {
    assertTrustedOrigin(request);
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
    const headers = new Headers(request.headers);
    headers.delete(SESSION_HEADER);
    const provider = authProvider();
    const pathname = request.nextUrl.pathname;
    if (provider.required(request)) {
      const session = provider.authenticate(request);
      if (session) headers.set(SESSION_HEADER, "1");
      else if (!isPublicPath(pathname)) {
        if (pathname === "/api" || pathname.startsWith("/api/")) return signInRequired();
        return signInRedirect(request);
      }
    } else if (pathname === SIGN_IN_PATH) {
      return redirect(request, "/");
    }
    return NextResponse.next({ request: { headers } });
  } catch (error) { return errorResponse(error); }
}

/**
 * A redirect on the site the browser is using. The request URL carries the bind address
 * (0.0.0.0), so the target is built from the Host header, which `assertTrustedOrigin` has checked.
 */
function redirect(request: NextRequest, path: string): NextResponse {
  const protocol = requestProtocol(request);
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return NextResponse.redirect(new URL(path, `${protocol}//${host}`), { status: 307, headers: { "Cache-Control": "no-store" } });
}

function signInRedirect(request: NextRequest): NextResponse {
  const search = new URLSearchParams(request.nextUrl.search);
  search.delete("_rsc");
  const query = search.toString();
  const next = `${request.nextUrl.pathname}${query ? `?${query}` : ""}`;
  return redirect(request, next === "/" ? SIGN_IN_PATH : `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`);
}

// Only the hashed build files skip the proxy; there is no public/ folder or favicon to exempt.
export const config = { matcher: ["/((?!_next/static/).*)"] };
