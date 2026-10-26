/**
 * Where an asset is used, for the delete-everywhere confirmation: every Library item, reference
 * sheet, shot, and export that would be marked broken.
 * @packageDocumentation
 */
import { libraryItemName } from "@/lib/domain/library";
import type { AssetUsage } from "@/lib/domain/usage";
import { assetUsage } from "@/server/media/lifecycle";
import type { Store } from "@/server/store";
import { parseId, route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

function describe(store: Store, entry: AssetUsage): string {
  const itemName = (id: string) => {
    const item = store.library.get(id);
    return item ? libraryItemName(item) : "a Library item";
  };
  const contentName = (id: string) => store.content.get(id)?.title ?? "a content piece";
  switch (entry.kind) {
    case "character_reference":
      return `${itemName(entry.itemId)}: ${entry.slot} reference`;
    case "library_image":
      return `${itemName(entry.itemId)}: Library image`;
    case "reference_sheet":
      return `${itemName(entry.itemId)}: reference sheet in ${store.projects.get(entry.projectId)?.name ?? "a project"}`;
    case "shot_approval":
      return `${contentName(entry.contentId)}: approved ${entry.slot} for beat ${entry.beatIndex}`;
    case "shot_candidate":
      return `${contentName(entry.contentId)}: ${entry.slot} candidate for beat ${entry.beatIndex}`;
    case "export_source":
      return "An export uses this clip";
    case "export_output":
      return "This is an exported ad";
    case "asset_input":
      return "Another asset was generated from this one (its history keeps the record)";
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const assetId = parseId((await params).id);
    return withStore((store) => {
      const asset = store.assets.getRequired(assetId);
      const usage = assetUsage(store, assetId);
      return Response.json({ asset, usage, affected: usage.map((entry) => describe(store, entry)) });
    });
  });
}
