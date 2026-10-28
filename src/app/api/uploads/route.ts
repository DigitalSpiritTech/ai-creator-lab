/**
 * Uploads one image (multipart field `image`, optional `projectId`) as an asset: product photos,
 * set photos, and real photos used as face or body references. `?as=sheet` stores it as a
 * reference sheet so it can be approved as a project's sheet; that needs a project, and an
 * identical image already used as something else is refused rather than repurposed. `?as=voice`
 * uploads a voice recording (field `audio`) to clone voice-overs from.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import { AssetSchema } from "@/lib/domain/asset";
import { fail } from "@/lib/domain/failure";
import { assertLocalRequest } from "@/server/http";
import { importAudio } from "@/server/media/audio";
import { importImage } from "@/server/media/images";
import { assetUsage } from "@/server/media/lifecycle";
import { readAudioUpload, readImageUpload } from "@/server/media/upload";
import { route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    assertLocalRequest(request);
    const as = new URL(request.url).searchParams.get("as");
    if (as !== null && as !== "sheet" && as !== "voice") return Response.json({ error: "Upload as an image, a sheet, or a voice recording." }, { status: 400 });
    if (as === "voice") {
      const recording = await readAudioUpload(request);
      return withStore(async (store) => Response.json({ asset: await importAudio(store, recording, { now: Date.now(), newId: randomUUID }) }, { status: 201 }));
    }
    const upload = await readImageUpload(request);
    if (as === "sheet" && !upload.projectId) return Response.json({ error: "Upload a reference sheet inside a project." }, { status: 400 });
    return withStore(async (store) => {
      let asset = await importImage(store, upload, { now: Date.now(), newId: randomUUID });
      if (as === "sheet" && asset.kind !== "sheet") {
        asset = store.transaction(() => {
          const current = store.assets.getRequired(asset.id);
          if (current.state.state !== "active") fail("invalid", "This image is archived; restore it first.");
          if (assetUsage(store, current.id).length > 0) fail("conflict", "This image is already used as another reference. Upload a different file for the sheet.");
          return store.assets.update(AssetSchema.parse({ ...current, kind: "sheet", revision: current.revision + 1 }));
        });
      }
      return Response.json({ asset }, { status: 201 });
    });
  });
}
