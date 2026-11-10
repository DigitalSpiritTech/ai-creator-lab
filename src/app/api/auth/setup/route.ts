/**
 * First run on a network: the setup code printed in the server log plus the new app password.
 * Sets the password (scrypt hash in `<dataDir>/auth.json`) and signs this browser in.
 * @packageDocumentation
 */
import { AuthSetupRequestSchema } from "@/lib/domain/auth";
import { authProvider } from "@/server/auth";
import { notNeededResponse, signInResponse } from "@/server/auth/responses";
import { errorResponse, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request, 2_048);
    const provider = authProvider();
    if (!provider.required(request)) return notNeededResponse();
    return signInResponse(await provider.setUp(AuthSetupRequestSchema.parse(body)), request);
  } catch (error) {
    return errorResponse(error);
  }
}
