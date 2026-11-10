/**
 * Streams one asset's file with byte ranges (video seeking) and HEAD; `?poster` serves a video's
 * first-frame poster and `?download` asks the browser to save the file.
 * @packageDocumentation
 */
import { assetResponse } from "@/server/media/asset-response";
import { parseId, route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

async function serve(request: Request, params: Promise<{ id: string }>): Promise<Response> {
  return route(async () => {
    const assetId = parseId((await params).id);
    return withStore((store) => assetResponse(request, store.assets.getRequired(assetId), store.dataDir));
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return serve(request, params);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return serve(request, params);
}
