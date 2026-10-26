/**
 * Where an asset is used, and the pure plans for archiving and deleting it everywhere.
 * @packageDocumentation
 */
import { z } from "zod";
import { type Asset, markAssetDeleted } from "@/lib/domain/asset";
import { IdSchema, nextRevision } from "@/lib/domain/common";
import { type ContentPiece, type ExportRecord, type Slot, SlotKindSchema } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import type { LibraryItem, ProjectLink } from "@/lib/domain/library";

export const AssetUsageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("character_reference"), itemId: IdSchema, slot: z.enum(["face", "body", "wardrobe"]) }),
  z.object({ kind: z.literal("library_image"), itemId: IdSchema }),
  z.object({ kind: z.literal("reference_sheet"), projectId: IdSchema, itemId: IdSchema }),
  z.object({ kind: z.literal("shot_candidate"), contentId: IdSchema, beatIndex: z.number().int(), slot: SlotKindSchema }),
  z.object({ kind: z.literal("shot_approval"), contentId: IdSchema, beatIndex: z.number().int(), slot: SlotKindSchema }),
  z.object({ kind: z.literal("export_source"), exportId: IdSchema }),
  z.object({ kind: z.literal("export_output"), exportId: IdSchema }),
  z.object({ kind: z.literal("asset_input"), assetId: IdSchema }),
]);
export type AssetUsage = z.infer<typeof AssetUsageSchema>;

/** Everything that can point at an asset. */
export interface AssetGraph {
  libraryItems: LibraryItem[];
  links: ProjectLink[];
  contents: ContentPiece[];
  exports: ExportRecord[];
  assets: Asset[];
}

export function findAssetUsage(graph: AssetGraph, assetId: string): AssetUsage[] {
  const usage: AssetUsage[] = [];
  for (const item of graph.libraryItems) {
    if (item.kind === "character") {
      const references = item.bible.references;
      if (references.faceAssetId === assetId) usage.push({ kind: "character_reference", itemId: item.id, slot: "face" });
      if (references.bodyAssetId === assetId) usage.push({ kind: "character_reference", itemId: item.id, slot: "body" });
      if (references.wardrobeAssetIds.includes(assetId)) {
        usage.push({ kind: "character_reference", itemId: item.id, slot: "wardrobe" });
      }
    } else if (item.imageAssetIds.includes(assetId)) {
      usage.push({ kind: "library_image", itemId: item.id });
    }
  }
  for (const link of graph.links) {
    if (link.kind === "character" && link.sheetAssetId === assetId) {
      usage.push({ kind: "reference_sheet", projectId: link.projectId, itemId: link.itemId });
    }
  }
  for (const content of graph.contents) {
    for (const shot of content.shots) {
      for (const slot of ["still", "clip"] as const) {
        const state = shot[slot];
        if (state.state === "approved" && state.assetId === assetId) {
          usage.push({ kind: "shot_approval", contentId: content.id, beatIndex: shot.beatIndex, slot });
        } else if (state.state !== "empty" && state.candidateIds.includes(assetId)) {
          usage.push({ kind: "shot_candidate", contentId: content.id, beatIndex: shot.beatIndex, slot });
        }
      }
    }
  }
  for (const record of graph.exports) {
    if (record.sources.some((source) => source.assetId === assetId)) usage.push({ kind: "export_source", exportId: record.id });
    if (record.status === "completed" && record.assetId === assetId) usage.push({ kind: "export_output", exportId: record.id });
  }
  for (const asset of graph.assets) {
    if (asset.provenance.source === "generated" && asset.provenance.inputs.some((input) => input.assetId === assetId)) {
      usage.push({ kind: "asset_input", assetId: asset.id });
    }
  }
  return usage;
}

/** Usage that makes archiving unsafe: the asset is an approved, load-bearing choice. */
export function blockingArchiveUsage(usage: AssetUsage[]): AssetUsage[] {
  return usage.filter(
    (entry) =>
      entry.kind === "character_reference" || entry.kind === "reference_sheet" || entry.kind === "shot_approval",
  );
}

export function assertArchivable(usage: AssetUsage[]): void {
  if (blockingArchiveUsage(usage).length > 0) {
    fail("conflict", "This asset is an approved reference or shot. Replace it before archiving.");
  }
}

function addBroken(list: string[], assetId: string): string[] {
  return list.includes(assetId) ? list : [...list, assetId];
}

function dropFromSlot(slot: Slot, assetId: string): Slot {
  if (slot.state === "empty" || !slot.candidateIds.includes(assetId)) return slot;
  const candidateIds = slot.candidateIds.filter((id) => id !== assetId);
  if (candidateIds.length === 0) return { state: "empty" };
  if (slot.state === "approved" && slot.assetId === assetId) return { state: "open", candidateIds, selectedId: null };
  if (slot.state === "open" && slot.selectedId === assetId) return { state: "open", candidateIds, selectedId: null };
  return { ...slot, candidateIds };
}

export interface DeletePlan {
  asset: Asset;
  usage: AssetUsage[];
  libraryItems: LibraryItem[];
  links: ProjectLink[];
  contents: ContentPiece[];
  exports: ExportRecord[];
}

/**
 * Plans "delete everywhere": the asset becomes a tombstone, every reference to it is removed,
 * and each dependent records the asset id in `brokenAssetIds`. Refuses when an export depends on
 * the asset unless `force` is set. Provenance of other assets is history and is left untouched.
 */
export function planDeleteEverywhere(
  graph: AssetGraph,
  asset: Asset,
  options: { force: boolean; now: number },
): DeletePlan {
  if (asset.state.state === "deleted") fail("not_found", "This asset was already deleted.");
  const usage = findAssetUsage(graph, asset.id);
  const exportUsage = usage.filter((entry) => entry.kind === "export_source" || entry.kind === "export_output");
  if (exportUsage.length > 0 && !options.force) {
    fail(
      "conflict",
      `An export depends on this asset (${exportUsage.length} reference${exportUsage.length === 1 ? "" : "s"}). Confirm again to delete it anyway.`,
    );
  }
  const { now } = options;
  const id = asset.id;
  const libraryItems: LibraryItem[] = [];
  for (const item of graph.libraryItems) {
    if (!usage.some((entry) => "itemId" in entry && entry.itemId === item.id && entry.kind !== "reference_sheet")) continue;
    if (item.kind === "character") {
      const references = item.bible.references;
      libraryItems.push({
        ...nextRevision(item, now),
        brokenAssetIds: addBroken(item.brokenAssetIds, id),
        bible: {
          ...item.bible,
          version: item.bible.version + 1,
          references: {
            faceAssetId: references.faceAssetId === id ? null : references.faceAssetId,
            bodyAssetId: references.bodyAssetId === id ? null : references.bodyAssetId,
            wardrobeAssetIds: references.wardrobeAssetIds.filter((entry) => entry !== id),
          },
        },
      });
    } else {
      libraryItems.push({
        ...nextRevision(item, now),
        brokenAssetIds: addBroken(item.brokenAssetIds, id),
        imageAssetIds: item.imageAssetIds.filter((entry) => entry !== id),
      });
    }
  }
  const links: ProjectLink[] = [];
  for (const link of graph.links) {
    if (link.kind !== "character" || link.sheetAssetId !== id) continue;
    links.push({
      ...nextRevision(link, now),
      sheetAssetId: null,
      sheetApprovedAt: null,
      brokenAssetIds: addBroken(link.brokenAssetIds, id),
    });
  }
  const contents: ContentPiece[] = [];
  for (const content of graph.contents) {
    const touched = content.shots.some((shot) =>
      [shot.still, shot.clip].some((slot) => slot.state !== "empty" && slot.candidateIds.includes(id)),
    );
    if (!touched) continue;
    contents.push({
      ...nextRevision(content, now),
      shots: content.shots.map((shot) => {
        const wasApproved = [shot.still, shot.clip].some((slot) => slot.state === "approved" && slot.assetId === id);
        return {
          ...shot,
          still: dropFromSlot(shot.still, id),
          clip: dropFromSlot(shot.clip, id),
          brokenAssetIds: wasApproved ? addBroken(shot.brokenAssetIds, id) : shot.brokenAssetIds,
        };
      }),
    });
  }
  const exports: ExportRecord[] = [];
  for (const record of graph.exports) {
    const depends =
      record.sources.some((source) => source.assetId === id) || (record.status === "completed" && record.assetId === id);
    if (depends) exports.push({ ...record, brokenAssetIds: addBroken(record.brokenAssetIds, id) });
  }
  return { asset: markAssetDeleted(asset, now), usage, libraryItems, links, contents, exports };
}
