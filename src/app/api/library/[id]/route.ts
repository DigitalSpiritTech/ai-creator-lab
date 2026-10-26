/**
 * One Library item with its project links and the assets it references (face, body, wardrobe,
 * product or set images, and each project's reference sheet).
 * @packageDocumentation
 */
import type { Asset } from "@/lib/domain/asset";
import { parseId, route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const itemId = parseId((await params).id);
    return withStore((store) => {
      const item = store.library.getRequired(itemId);
      const links = store.library.listAllLinks().filter((link) => link.itemId === itemId);
      const ids = new Set<string>();
      if (item.kind === "character") {
        const { faceAssetId, bodyAssetId, wardrobeAssetIds } = item.bible.references;
        for (const id of [faceAssetId, bodyAssetId, ...wardrobeAssetIds]) if (id) ids.add(id);
      } else {
        for (const id of item.imageAssetIds) ids.add(id);
      }
      for (const link of links) if (link.kind === "character" && link.sheetAssetId) ids.add(link.sheetAssetId);
      const assets = [...ids].map((id) => store.assets.get(id)).filter((asset): asset is Asset => !!asset);
      const linked = new Set(links.map((link) => link.projectId));
      const projects = store.projects.list().map(({ id, name }) => ({ id, name, linked: linked.has(id) }));
      return Response.json({ item, links, projects, assets });
    });
  });
}
