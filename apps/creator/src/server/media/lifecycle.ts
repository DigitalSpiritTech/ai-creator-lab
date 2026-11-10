/**
 * Archive, restore, and delete-everywhere for assets, applied atomically across every record
 * that references the asset. Files are removed only after the database commit.
 * @packageDocumentation
 */
import { type Asset, archiveAsset, restoreAsset } from "@creator-lab/core/domain/asset";
import {
  type AssetGraph,
  type AssetUsage,
  assertArchivable,
  findAssetUsage,
  planDeleteEverywhere,
} from "@creator-lab/core/domain/usage";
import { fail } from "@creator-lab/core/domain/failure";
import { type Chain, isChainActive } from "@creator-lab/executors/chain";
import { removeMedia } from "@/server/media/files";
import type { Store } from "@/server/store";

export function loadAssetGraph(store: Store): AssetGraph {
  return {
    libraryItems: store.library.list({ includeArchived: true }),
    links: store.library.listAllLinks(),
    contents: store.content.listAll(),
    exports: store.content.listExports(),
    assets: store.assets.list({ state: "any" }),
    pieces: store.pieces.listAll(),
  };
}

export function assetUsage(store: Store, assetId: string): AssetUsage[] {
  return findAssetUsage(loadAssetGraph(store), assetId);
}

/** How an unfinished chained recording reads an asset. */
export interface ChainUse {
  chain: Chain;
  /** "the starting still", "the identity reference", "the voice recording", or "segment N". */
  role: string;
}

/**
 * The unfinished chained recordings that read an asset: their starting still, identity reference,
 * voice recording, or a segment already made (the next segment starts from it, and the stitch reads
 * it). The usage list reports them, and deleting the asset is refused while one is active.
 */
export function chainUses(store: Store, assetId: string): ChainUse[] {
  const uses: ChainUse[] = [];
  for (const chain of store.chains.listOpen()) {
    chain.inputs.forEach((pin, position) => {
      if (pin.assetId === assetId) uses.push({ chain, role: position === 0 ? "the starting still" : "the identity reference" });
    });
    if (chain.spine?.assetId === assetId) uses.push({ chain, role: "the voice recording" });
    for (const segment of chain.segments) if (segment.assetId === assetId) uses.push({ chain, role: `segment ${segment.index}` });
  }
  return uses;
}

/** A chain use in words, for the delete confirmation and the refusal. */
export function describeChainUse(use: ChainUse): string {
  const made = use.chain.segments.filter((segment) => segment.assetId).length;
  const state = use.chain.status === "paused" ? "paused" : "in progress";
  return `A chained recording ${state} (${made} of ${use.chain.segments.length} segments made) uses this as ${use.role}`;
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
    // A running chain would wait on a file that is gone while it holds its budget: finish or cancel it first.
    const busy = chainUses(store, assetId).filter((use) => isChainActive(use.chain));
    if (busy.length) fail("conflict", `${describeChainUse(busy[0])}. Wait for it to finish, or cancel it, before deleting this everywhere.`);
    const planned = planDeleteEverywhere(loadAssetGraph(store), asset, options);
    for (const item of planned.libraryItems) store.library.update(item);
    for (const link of planned.links) store.library.updateLink(link);
    for (const content of planned.contents) store.content.update(content);
    for (const piece of planned.pieces) store.pieces.update(piece);
    for (const record of planned.exports) store.content.markExportBroken(record.id, record.brokenAssetIds);
    store.assets.update(planned.asset);
    return { planned, original: asset };
  });
  const files = [plan.original.relativePath];
  if (plan.original.video?.posterPath) files.push(plan.original.video.posterPath);
  await removeMedia(store.dataDir, files);
  return { asset: plan.planned.asset, usage: plan.planned.usage };
}
