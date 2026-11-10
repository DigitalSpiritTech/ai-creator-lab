/**
 * Signs this browser in with the app password. Failed attempts are slowed and capped (see
 * `@/server/auth/rate-limit`).
 * @packageDocumentation
 */
import { AuthLoginRequestSchema } from "@/lib/domain/auth";
import { authProvider } from "@/server/auth";
import { notNeededResponse, signInResponse } from "@/server/auth/responses";
import { errorResponse, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request, 2_048);
    const provider = authProvider();
    if (!provider.required(request)) return notNeededResponse();
    return signInResponse(await provider.signIn(AuthLoginRequestSchema.parse(body)), request);
  } catch (error) {
    return errorResponse(error);
  }
}
