/**
 * Archive, restore, and delete-everywhere for assets, applied atomically across every record
 * that references the asset. Files are removed only after the database commit.
 * @packageDocumentation
 */
import { type Asset, archiveAsset, restoreAsset } from "@/lib/domain/asset";
import {
  type AssetGraph,
  type AssetUsage,
  assertArchivable,
  findAssetUsage,
  planDeleteEverywhere,
} from "@/lib/domain/usage";
import { removeMedia } from "@/server/media/files";
import type { Store } from "@/server/store";

export function loadAssetGraph(store: Store): AssetGraph {
  return {
    libraryItems: store.library.list({ includeArchived: true }),
    links: store.library.listAllLinks(),
    contents: store.content.listAll(),
    exports: store.content.listExports(),
    assets: store.assets.list({ state: "any" }),
  };
}

export function assetUsage(store: Store, assetId: string): AssetUsage[] {
  return findAssetUsage(loadAssetGraph(store), assetId);
}

/** Archives an asset unless it is an approved reference, sheet, or shot. */
export function archiveStoredAsset(store: Store, assetId: string, reason: string, now: number): Asset {
  return store.transaction(() => {
    const asset = store.assets.getRequired(assetId);
    if (asset.state.state === "archived") return asset;
    assertArchivable(assetUsage(store, assetId));
    return store.assets.update(archiveAsset(asset, reason, now));
  });
}

export function restoreStoredAsset(store: Store, assetId: string): Asset {
  return store.transaction(() => {
    const asset = store.assets.getRequired(assetId);
    if (asset.state.state === "active") return asset;
    return store.assets.update(restoreAsset(asset));
  });
}

/**
 * Deletes an asset everywhere: tombstones the row, removes it from every dependent (marking them
 * broken), then removes its files. Refuses when an export depends on it unless `force`.
 */
export async function deleteAssetEverywhere(
  store: Store,
  assetId: string,
  options: { force: boolean; now: number },
): Promise<{ asset: Asset; usage: AssetUsage[] }> {
  const plan = store.transaction(() => {
    const asset = store.assets.getRequired(assetId);
    const planned = planDeleteEverywhere(loadAssetGraph(store), asset, options);
    for (const item of planned.libraryItems) store.library.update(item);
    for (const link of planned.links) store.library.updateLink(link);
    for (const content of planned.contents) store.content.update(content);
    for (const record of planned.exports) store.content.markExportBroken(record.id, record.brokenAssetIds);
    store.assets.update(planned.asset);
    return { planned, original: asset };
  });
  const files = [plan.original.relativePath];
  if (plan.original.video) files.push(plan.original.video.posterPath);
  await removeMedia(store.dataDir, files);
  return { asset: plan.planned.asset, usage: plan.planned.usage };
}
