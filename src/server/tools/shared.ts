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

/**
 * The other active candidates competing with `asset`: outputs of the same job and, for a
 * character reference or reference sheet, outputs of every job aimed at the same target (a
 * proposal runs one job per candidate).
 */
export function jobSiblings(store: Store, asset: Asset): string[] {
  if (asset.provenance.source !== "generated") return [];
  const source = store.jobs.get(asset.provenance.jobId);
  const target = source?.request.target;
  const jobIds = new Set([asset.provenance.jobId]);
  if (source && target && (target.kind === "character_reference" || target.kind === "reference_sheet")) {
    const key = JSON.stringify(target);
    for (const job of store.jobs.listByProject(source.projectId)) {
      if (JSON.stringify(job.request.target) === key) jobIds.add(job.id);
    }
  }
  return [...jobIds]
    .flatMap((jobId) => store.assets.list({ jobId, state: "active" }))
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
