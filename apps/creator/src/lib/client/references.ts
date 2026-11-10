/**
 * Real photos as references: upload, then lock the face or body, approve an own reference sheet,
 * or create a set. Each is the public upload route followed by the same tool the generated path uses.
 * @packageDocumentation
 */
import { callTool, uploadImage } from "@/lib/client/api";
import { bibleFields } from "@/lib/client/library";
import type { Asset, CharacterItem } from "@/lib/client/types";

/** Uploads a photo and locks it as the character's face or body reference. */
export async function lockPhotoAsReference(file: File, target: { characterId: string; slot: "face" | "body"; projectId?: string | null }): Promise<Asset> {
  const { asset } = await uploadImage(file, target.projectId);
  await callTool("select_reference", { characterId: target.characterId, slot: target.slot, assetId: asset.id }, target.projectId ?? undefined);
  return asset;
}

/**
 * Uploads an image as this project's reference sheet and approves it. Records the wardrobe first
 * when it changed, since a sheet is approved for one wardrobe.
 */
export async function approveOwnSheet(
  file: File,
  target: { projectId: string; character: CharacterItem; currentWardrobe: string | null; wardrobe: string },
): Promise<Asset> {
  const wardrobe = target.wardrobe.trim();
  if (wardrobe && wardrobe !== target.currentWardrobe) {
    await callTool(
      "save_character_bible",
      { characterId: target.character.id, revision: target.character.revision, projectId: target.projectId, wardrobe, bible: bibleFields(target.character) },
      target.projectId,
    );
  }
  const { asset } = await uploadImage(file, target.projectId, { as: "sheet" });
  await callTool("approve", { kind: "sheet", assetId: asset.id, projectId: target.projectId, characterId: target.character.id }, target.projectId);
  return asset;
}

/** Uploads set photos and creates the set, linked to the project when one is given. */
export async function createSetFromPhotos(files: File[], set: { name: string; notes: string }, projectId?: string): Promise<{ set: { id: string } }> {
  const imageAssetIds: string[] = [];
  for (const file of files) {
    const { asset } = await uploadImage(file, projectId);
    if (!imageAssetIds.includes(asset.id)) imageAssetIds.push(asset.id);
  }
  return callTool("create_set", { projectId, set: { name: set.name.trim(), notes: set.notes.trim(), imageAssetIds } }, projectId);
}
