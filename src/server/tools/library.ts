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
  ProjectLinkSchema,
  chooseWardrobe,
  createCharacter,
  createProduct,
  linkToProject,
  reviseCharacterBible,
  setCharacterReference,
  updateProduct,
} from "@/lib/domain/library";
import type { Store } from "@/server/store";
import { defineTool } from "@/server/tools/registry";
import { archiveUnselected, checkRevision, jobSiblings, requireActiveAsset } from "@/server/tools/shared";

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
