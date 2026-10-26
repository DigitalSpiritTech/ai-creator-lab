/**
 * Turns stored Library items back into the editable fields their save tools take, so linking an
 * item to a project re-saves it unchanged.
 * @packageDocumentation
 */
import type { CharacterBibleFields, ProductFields, ProductItem } from "@/lib/domain/library";
import type { CharacterItem } from "@/lib/client/types";

export function bibleFields(item: CharacterItem): CharacterBibleFields {
  const bible = item.bible;
  return {
    name: bible.name,
    ageRange: bible.ageRange,
    look: bible.look,
    build: bible.build,
    wardrobeDefaults: bible.wardrobeDefaults,
    voice: bible.voice,
    vibe: bible.vibe,
    backstory: bible.backstory,
    boundaries: bible.boundaries,
    visualCore: bible.visualCore,
  };
}

export function productFields(item: ProductItem): ProductFields {
  return { name: item.name, link: item.link, allowedClaims: item.allowedClaims, imageAssetIds: item.imageAssetIds };
}
