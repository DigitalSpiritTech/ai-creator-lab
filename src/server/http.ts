/**
 * Validates local HTTP mutations and formats safe API failures.
 *
 * Inputs: HTTP requests and unknown failures. Output: JSON data or responses.
 * Expected errors: invalid body, unsupported origin, or invalid runtime contracts.
 * @packageDocumentation
 */
import { z } from "zod";
import { assertSignedIn } from "@/server/auth";
import { acceptedHosts, isNetworkExposed, requestProtocol } from "@/server/auth/network";
import { READ_ONLY_MESSAGE, READ_ONLY_METHODS, isReadOnly, publicHost } from "@/server/demo";
import { ServiceFailureSchema } from "@/lib/domain/failure";

/**
 * The whole per-request policy for routes: trusted host and origin, the read-only flag, and a
 * signed-in session when the server is reachable from the network (see `@/server/auth`).
 * @param request - Incoming request.
 * @returns Nothing.
 * @throws A 403 Response for untrusted hosts or origins or a write in read-only mode, or a 401
 * Response when a session is required and missing.
 */
export function assertLocalRequest(request: Request): void {
  assertTrustedOrigin(request);
  if (isReadOnly() && !READ_ONLY_METHODS.has(request.method)) {
    throw Response.json({ error: READ_ONLY_MESSAGE }, { status: 403 });
  }
  assertSignedIn(request);
}

/**
 * Prevents cross-origin requests and DNS-rebinding access: the Host must be one this server
 * answers to, and a browser request must come from the app's own origin. Not authentication.
 * @param request - Incoming request.
 * @returns Nothing.
 * @throws A 403 Response for untrusted hosts or origins.
 */
export function assertTrustedOrigin(request: Request): void {
  const url = new URL(request.url);
  const allowedHosts = acceptedHosts();
  const exposed = isNetworkExposed(process.env, url.hostname) || !!publicHost();
  const host = request.headers.get("host");
  let headerHostname: string | undefined;
  try { headerHostname = host ? new URL(`http://${host}`).hostname : undefined; }
  catch { throw Response.json({ error: "Invalid studio host." }, { status: 403 }); }
  // A server listening beyond loopback gets the bind address (0.0.0.0, a LAN address) in the
  // framework's request URL; the Host header, which the browser or a platform proxy sets, is what
  // identifies the site there, and it must be one of the accepted names.
  const urlHostOk = exposed ? !!headerHostname : allowedHosts.includes(url.hostname);
  if (!urlHostOk || (headerHostname && !allowedHosts.includes(headerHostname))) {
    throw Response.json(
      { error: exposed ? "This host name is not one this studio answers to. Add it to STUDIO_ALLOWED_HOSTS." : "This edition is available on localhost only." },
      { status: 403 },
    );
  }
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  // Next.js can normalize request.url to localhost; the validated Host preserves
  // the actual browser origin (including 127.0.0.1 and the chosen port).
  // Behind a TLS proxy the server sees http inside while the browser speaks https; the proxy's
  // X-Forwarded-Proto is believed only when a proxy is named (see `requestProtocol`).
  const protocol = requestProtocol(request);
  const expectedOrigin = host ? new URL(`${protocol}//${host}`).origin : url.origin;
  // A link to the app from another site (a README, a chat) is a top-level navigation: the page
  // loads in its own tab and the other site reads nothing. Every other cross-site request, a
  // form post, a fetch, an image or script load, is refused.
  const navigation =
    (request.method === "GET" || request.method === "HEAD") &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document";
  if ((origin && origin !== expectedOrigin) || (site && !["same-origin", "none"].includes(site) && !navigation)) {
    throw Response.json({ error: "Cross-origin studio requests are not allowed." }, { status: 403 });
  }
}

/**
 * Reads a small JSON mutation payload.
 * @param request - Incoming request.
 * @param limit - Maximum JSON characters; defaults to 16 KiB.
 * @returns Parsed untrusted JSON.
 * @throws A 400, 403, 413, or 415 Response for invalid requests.
 */
export async function readJson(request: Request, limit = 16_384): Promise<unknown> {
  assertLocalRequest(request);
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw Response.json({ error: "Send a JSON request." }, { status: 415 });
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit * 4) throw Response.json({ error: "The request is too large." }, { status: 413 });
  const text = await request.text();
  if (text.length > limit) throw Response.json({ error: "The request is too large." }, { status: 413 });
  try { return JSON.parse(text); } catch {
    throw Response.json({ error: "The request is not valid JSON." }, { status: 400 });
  }
}

/**
 * Converts errors into safe HTTP responses.
 * @param error - Unknown exception from a route.
 * @returns JSON error response without secrets or filesystem paths.
 * @throws No expected errors.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof Response) return error;
  if (error instanceof z.ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const known = ServiceFailureSchema.safeParse(error);
  if (known.success) {
    const status = known.data.code === "not_found" ? 404 : known.data.code === "conflict" ? 409 : known.data.code === "invalid" ? 400 : known.data.code === "provider" ? 503 : 500;
    return Response.json({ error: known.data.message }, { status });
  }
  return Response.json({ error: "The studio could not complete this request. Please try again." }, { status: 500 });
}
