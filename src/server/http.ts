/**
 * Validates local HTTP mutations and formats safe API failures.
 *
 * Inputs: HTTP requests and unknown failures. Output: JSON data or responses.
 * Expected errors: invalid body, unsupported origin, or invalid runtime contracts.
 * @packageDocumentation
 */
import { z } from "zod";
import { ServiceFailureSchema } from "@/lib/domain/failure";

/**
 * Prevents cross-origin writes and DNS-rebinding access to this local application.
 * @param request - Incoming request.
 * @returns Nothing.
 * @throws A 403 Response for untrusted hosts or origins.
 */
export function assertLocalRequest(request: Request): void {
  const url = new URL(request.url);
  const allowedHosts = ["localhost", "127.0.0.1", "[::1]"];
  const host = request.headers.get("host");
  let headerHostname: string | undefined;
  try { headerHostname = host ? new URL(`http://${host}`).hostname : undefined; }
  catch { throw Response.json({ error: "Invalid studio host." }, { status: 403 }); }
  if (!allowedHosts.includes(url.hostname) ||
      (headerHostname && !allowedHosts.includes(headerHostname))) {
    throw Response.json({ error: "This edition is available on localhost only." }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  // Next.js can normalize request.url to localhost; the validated Host preserves
  // the actual browser origin (including 127.0.0.1 and the chosen port).
  const expectedOrigin = host ? new URL(`${url.protocol}//${host}`).origin : url.origin;
  if ((origin && origin !== expectedOrigin) || (site && !["same-origin", "none"].includes(site))) {
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
