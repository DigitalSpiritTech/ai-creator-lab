/**
 * Saves keys from Settings into `<dataDir>/secrets.json` (mode 0600). The response is the key
 * status only; values are never echoed back.
 * @packageDocumentation
 */
import { readJson } from "@/server/http";
import { SecretsPatchSchema, secretsStatus, writeSecrets } from "@/server/secrets";
import { route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const patch = SecretsPatchSchema.parse(await readJson(request));
    return withStore((store) => {
      writeSecrets(store.dataDir, patch);
      return Response.json({ keys: secretsStatus(store.dataDir) });
    });
  });
}
