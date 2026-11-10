/**
 * Settings connection check: Comfy account status and credit balance for the configured key.
 * The response carries status and numbers only, never the key.
 * @packageDocumentation
 */
import { readSecrets } from "@/server/secrets";
import { checkComfyConnection } from "@/app/api/_lib/connection";
import { route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return route(() =>
    withStore(async (store) => Response.json(await checkComfyConnection(readSecrets(store.dataDir).comfyApiKey))),
  );
}
