/**
 * Helpers shared by tool implementations.
 * @packageDocumentation
 */
import { type Asset, archiveAsset } from "@/lib/domain/asset";
import { fail } from "@/lib/domain/failure";
import { blockingArchiveUsage, findAssetUsage } from "@/lib/domain/usage";
import { loadAssetGraph } from "@/server/media/lifecycle";
import type { Store } from "@/server/store";

export const NOT_SELECTED = "not selected";

export function checkRevision(current: number, expected: number | undefined, what: string): void {
  if (expected !== undefined && expected !== current) {
    fail("conflict", `The ${what} changed since you last read it. Read it again before saving.`);
  }
}

/** Other active outputs of the job that produced `asset`. */
export function jobSiblings(store: Store, asset: Asset): string[] {
  if (asset.provenance.source !== "generated") return [];
  return store.assets
    .list({ jobId: asset.provenance.jobId, state: "active" })
    .map((sibling) => sibling.id)
    .filter((id) => id !== asset.id);
}

/** Archives active, unused assets with the reason "not selected"; skips any that are approved elsewhere. */
export function archiveUnselected(store: Store, assetIds: string[], now: number): string[] {
  const graph = loadAssetGraph(store);
  const archived: string[] = [];
  for (const id of assetIds) {
    const asset = store.assets.get(id);
    if (!asset || asset.state.state !== "active") continue;
    if (blockingArchiveUsage(findAssetUsage(graph, id)).length > 0) continue;
    store.assets.update(archiveAsset(asset, NOT_SELECTED, now));
    archived.push(id);
  }
  return archived;
}

export function requireActiveAsset(store: Store, assetId: string, kinds: Asset["kind"][]): Asset {
  const asset = store.assets.getRequired(assetId);
  if (asset.state.state !== "active") fail("invalid", "Restore this asset before using it.");
  if (!kinds.includes(asset.kind)) fail("invalid", `Choose a ${kinds.join(" or ")} asset.`);
  return asset;
}
