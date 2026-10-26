/**
 * Library tools: character bible, face and body reference lock, product card.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, RevisionSchema, text } from "@/lib/domain/common";
import { fail } from "@/lib/domain/failure";
import {
  type CharacterItem,
  CharacterBibleFieldsSchema,
  CharacterItemSchema,
  CharacterLinkSchema,
  type ProductItem,
  ProductFieldsSchema,
  ProductItemSchema,
  LibraryItemSchema,
  ProjectLinkSchema,
  type SetItem,
  SetFieldsSchema,
  SetItemSchema,
  chooseWardrobe,
  createSet,
  libraryItemName,
  setLibraryItemArchived,
  createCharacter,
  createProduct,
  linkToProject,
  reviseCharacterBible,
  setCharacterReference,
  updateProduct,
} from "@/lib/domain/library";
import type { Store } from "@/server/store";
import { defineTool } from "@/server/tools/registry";
import { archiveUnselected, checkRevision, jobSiblings, libraryItemAssetIds, requireActiveAsset } from "@/server/tools/shared";

function requireCharacter(store: Store, id: string): CharacterItem {
  const item = store.library.getRequired(id);
  if (item.kind !== "character") fail("invalid", "Choose a character from the Library.");
  return item;
}

function requireProduct(store: Store, id: string): ProductItem {
  const item = store.library.getRequired(id);
  if (item.kind !== "product") fail("invalid", "Choose a product from the Library.");
  return item;
}

export const saveCharacterBible = defineTool({
  name: "save_character_bible",
  description:
    "Create a Library character from a bible, or revise an existing one (pass characterId). The visualCore is one dense sentence under 60 words that starts every image prompt. With projectId, the character is linked to that project; with wardrobe, that outfit is recorded for the project's reference sheet.",
  input: z
    .object({
      characterId: IdSchema.optional(),
      revision: RevisionSchema.optional(),
      projectId: IdSchema.optional(),
      wardrobe: text(300).optional().describe("The outfit this project uses, usually one of wardrobeDefaults."),
      bible: CharacterBibleFieldsSchema,
    })
    .strict()
    .refine((input) => input.wardrobe === undefined || input.projectId !== undefined, "A wardrobe needs a projectId."),
  output: z.object({ character: CharacterItemSchema, link: CharacterLinkSchema.nullable() }),
  run: ({ store, now, newId }, input) =>
    store.transaction(() => {
      const time = now();
      let character: CharacterItem;
      if (input.characterId) {
        const current = requireCharacter(store, input.characterId);
        checkRevision(current.revision, input.revision, "character");
        character = store.library.update(reviseCharacterBible(current, input.bible, time)) as CharacterItem;
      } else {
        character = store.library.create(createCharacter(newId(), input.bible, time)) as CharacterItem;
      }
      if (!input.projectId) return { character, link: null };
      store.projects.getRequired(input.projectId);
      const linked = store.library.link(linkToProject(input.projectId, character, time));
      if (linked.kind !== "character") fail("invalid", "This link is not a character link.");
      const link = input.wardrobe ? store.library.updateLink(chooseWardrobe(linked, input.wardrobe, time)) : linked;
      return { character, link: CharacterLinkSchema.parse(link) };
    }),
});

export const selectReference = defineTool({
  name: "select_reference",
  description:
    "Lock a character's face or body reference to one image, bump the bible version, and archive the other candidates from the same generation with the reason 'not selected'. The face must be locked before the body.",
  input: z
    .object({
      characterId: IdSchema,
      slot: z.enum(["face", "body"]),
      assetId: IdSchema,
      archiveSiblings: z.boolean().default(true),
    })
    .strict(),
  output: z.object({ character: CharacterItemSchema, archivedAssetIds: z.array(IdSchema) }),
  run: ({ store, now }, input) =>
    store.transaction(() => {
      const time = now();
      const current = requireCharacter(store, input.characterId);
      const asset = requireActiveAsset(store, input.assetId, ["image"]);
      const character = store.library.update(setCharacterReference(current, input.slot, asset, time)) as CharacterItem;
      const archivedAssetIds = input.archiveSiblings ? archiveUnselected(store, jobSiblings(store, asset), time) : [];
      return { character, archivedAssetIds };
    }),
});

export const saveProduct = defineTool({
  name: "save_product",
  description:
    "Create or update (pass productId) a Library product card: name, link, the claims the ad is allowed to make, and product image asset ids. Only claims listed here may appear in a script. With projectId, the product is linked to that project.",
  input: z
    .object({
      productId: IdSchema.optional(),
      revision: RevisionSchema.optional(),
      projectId: IdSchema.optional(),
      product: ProductFieldsSchema,
    })
    .strict(),
  output: z.object({ product: ProductItemSchema, link: ProjectLinkSchema.nullable() }),
  run: ({ store, now, newId }, input) =>
    store.transaction(() => {
      const time = now();
      for (const assetId of input.product.imageAssetIds ?? []) requireActiveAsset(store, assetId, ["image"]);
      let product: ProductItem;
      if (input.productId) {
        const current = requireProduct(store, input.productId);
        checkRevision(current.revision, input.revision, "product");
        product = store.library.update(updateProduct(current, input.product, time)) as ProductItem;
      } else {
        product = store.library.create(createProduct(newId(), input.product, time)) as ProductItem;
      }
      if (!input.projectId) return { product, link: null };
      store.projects.getRequired(input.projectId);
      return { product, link: store.library.link(linkToProject(input.projectId, product, time)) };
    }),
});

export const linkLibraryItem = defineTool({
  name: "link_library_item",
  description:
    "Attach an existing Library character, product, or set to a project so it can be used there. The item itself is not changed and the bible version stays the same. Linking again is a no-op. Archived items cannot be linked until restored.",
  input: z.object({ projectId: IdSchema, itemId: IdSchema }).strict(),
  output: ProjectLinkSchema,
  run: ({ store, now }, input) =>
    store.transaction(() => {
      store.projects.getRequired(input.projectId);
      const item = store.library.getRequired(input.itemId);
      if (item.archived) fail("invalid", `${libraryItemName(item)} is archived. Restore it before linking.`);
      return store.library.link(linkToProject(input.projectId, item, now()));
    }),
});

/** Every asset an asset was made from, following provenance inputs a few generations back. */
function ancestry(store: Store, assetId: string): Set<string> {
  const seen = new Set<string>([assetId]);
  let frontier = [assetId];
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const asset = store.assets.get(id);
      if (asset?.provenance.source !== "generated") continue;
      for (const input of asset.provenance.inputs) {
        if (!seen.has(input.assetId)) {
          seen.add(input.assetId);
          next.push(input.assetId);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

export const unlinkLibraryItem = defineTool({
  name: "unlink_library_item",
  description:
    "Detach a Library item from a project. The item stays in the Library unchanged. Refused while an approved still or clip in the project was made from the item's images (or the project's reference sheet), so approved shots never lose their source.",
  input: z.object({ projectId: IdSchema, itemId: IdSchema }).strict(),
  output: z.object({ projectId: IdSchema, itemId: IdSchema, unlinked: z.literal(true) }),
  run: ({ store }, input) =>
    store.transaction(() => {
      const link = store.library.getLink(input.projectId, input.itemId) ?? fail("not_found", "This Library item is not linked to the project.");
      const item = store.library.getRequired(input.itemId);
      const held = new Set(libraryItemAssetIds(item));
      if (link.kind === "character" && link.sheetAssetId) held.add(link.sheetAssetId);
      for (const content of store.content.listByProject(input.projectId)) {
        for (const shot of content.shots) {
          for (const slot of ["still", "clip"] as const) {
            const state = shot[slot];
            if (state.state !== "approved") continue;
            if ([...ancestry(store, state.assetId)].some((id) => held.has(id))) {
              fail(
                "invalid",
                `Beat ${shot.beatIndex}'s approved ${slot} in "${content.title}" was made from ${libraryItemName(item)}'s images. Replace or archive that ${slot} before unlinking.`,
              );
            }
          }
        }
      }
      store.library.unlink(input.projectId, input.itemId);
      return { projectId: input.projectId, itemId: input.itemId, unlinked: true as const };
    }),
});

export const archiveLibraryItem = defineTool({
  name: "archive_library_item",
  description:
    "Archive a Library character, product, or set so it is hidden from new selections (it cannot be linked or picked for new stills), or restore it with restore: true. Its assets and existing links are kept.",
  input: z.object({ itemId: IdSchema, restore: z.boolean().default(false) }).strict(),
  output: LibraryItemSchema,
  run: ({ store, now }, input) =>
    store.transaction(() => {
      const item = store.library.getRequired(input.itemId);
      const next = setLibraryItemArchived(item, !input.restore, now());
      return next === item ? item : store.library.update(next);
    }),
});

export const createSetTool = defineTool({
  name: "create_set",
  description:
    "Create a Library set (a location): name, notes, and reference image asset ids. With projectId it is linked to that project. A beat whose setting names the set uses its first image as a location reference in stills.",
  input: z
    .object({
      projectId: IdSchema.optional(),
      set: SetFieldsSchema,
    })
    .strict(),
  output: z.object({ set: SetItemSchema, link: ProjectLinkSchema.nullable() }),
  run: ({ store, now, newId }, input) =>
    store.transaction(() => {
      const time = now();
      for (const assetId of input.set.imageAssetIds ?? []) requireActiveAsset(store, assetId, ["image"]);
      const set = store.library.create(createSet(newId(), input.set, time)) as SetItem;
      if (!input.projectId) return { set, link: null };
      store.projects.getRequired(input.projectId);
      return { set, link: store.library.link(linkToProject(input.projectId, set, time)) };
    }),
});
