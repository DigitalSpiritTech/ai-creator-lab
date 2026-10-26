/**
 * Uploads one image (multipart field `image`, optional `projectId`) as an asset, for product photos
 * and set references.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import { assertLocalRequest } from "@/server/http";
import { importImage } from "@/server/media/images";
import { readImageUpload } from "@/server/media/upload";
import { route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    assertLocalRequest(request);
    const upload = await readImageUpload(request);
    return withStore(async (store) => {
      const asset = await importImage(store, upload, { now: Date.now(), newId: randomUUID });
      return Response.json({ asset }, { status: 201 });
    });
  });
}
