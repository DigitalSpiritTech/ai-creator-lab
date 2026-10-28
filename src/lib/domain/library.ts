/**
 * Library items (character, product, set) reused across projects, and their project links.
 * The character bible follows the character-bible skill; the project-character link carries the
 * project's wardrobe choice and its approved reference sheet.
 * @packageDocumentation
 */
import { z } from "zod";
import type { Asset } from "@/lib/domain/asset";
import {
  IdSchema,
  RevisionSchema,
  TimestampSchema,
  nextRevision,
  optionalText,
  text,
  wordCount,
} from "@/lib/domain/common";
import { fail } from "@/lib/domain/failure";

export const CharacterLookSchema = z
  .object({
    face: text(300),
    hair: text(200),
    skin: text(200),
    eyes: text(120),
    distinguishingDetails: optionalText(300),
  })
  .strict();

export const CharacterVoiceSchema = z
  .object({
    style: text(300),
    pace: text(120),
    phrasesUsed: z.array(text(120)).max(8).default([]),
    phrasesAvoided: z.array(text(120)).max(8).default([]),
  })
  .strict();

export const CharacterReferencesSchema = z
  .object({
    faceAssetId: IdSchema.nullable(),
    bodyAssetId: IdSchema.nullable(),
    wardrobeAssetIds: z.array(IdSchema).max(12).default([]),
    /** The voice sample every voice-over is cloned from: an uploaded recording or a talking clip's audio. */
    voiceAssetId: IdSchema.nullable().default(null),
  })
  .strict();
export type CharacterReferences = z.infer<typeof CharacterReferencesSchema>;

const bibleFields = {
  name: text(60),
  ageRange: text(40),
  look: CharacterLookSchema,
  build: text(200),
  wardrobeDefaults: z.array(text(200)).min(1).max(3),
  voice: CharacterVoiceSchema,
  vibe: z.array(text(40)).length(3),
  backstory: text(500),
  boundaries: z.array(text(200)).max(10),
  visualCore: text(600).refine((value) => wordCount(value) < 60, "Keep the visual core under 60 words."),
};

/** The editable part of a bible; references and version are managed by transitions. */
export const CharacterBibleFieldsSchema = z.object(bibleFields).strict();
export type CharacterBibleFields = z.input<typeof CharacterBibleFieldsSchema>;

export const CharacterBibleSchema = z
  .object({ ...bibleFields, references: CharacterReferencesSchema, version: z.number().int().positive() })
  .strict();
export type CharacterBible = z.infer<typeof CharacterBibleSchema>;

const itemBase = {
  id: IdSchema,
  archived: z.boolean(),
  brokenAssetIds: z.array(IdSchema).default([]),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

const productFields = {
  name: text(120),
  /** How the product looks (shape, color, material, cap, size cues, no brand text); image prompts use this instead of the name. */
  appearance: optionalText(300),
  link: z.url({ protocol: /^https?$/ }).max(2000).nullable().default(null),
  allowedClaims: z.array(text(200)).max(12).default([]),
  imageAssetIds: z.array(IdSchema).max(12).default([]),
};
export const ProductFieldsSchema = z.object(productFields).strict();
export type ProductFields = z.input<typeof ProductFieldsSchema>;

const setFields = {
  name: text(120),
  notes: optionalText(1000),
  imageAssetIds: z.array(IdSchema).max(12).default([]),
};
export const SetFieldsSchema = z.object(setFields).strict();
export type SetFields = z.input<typeof SetFieldsSchema>;

export const CharacterItemSchema = z
  .object({ ...itemBase, kind: z.literal("character"), bible: CharacterBibleSchema })
  .strict();
export const ProductItemSchema = z.object({ ...itemBase, kind: z.literal("product"), ...productFields }).strict();
export const SetItemSchema = z.object({ ...itemBase, kind: z.literal("set"), ...setFields }).strict();
export const LibraryItemSchema = z.discriminatedUnion("kind", [CharacterItemSchema, ProductItemSchema, SetItemSchema]);
export type CharacterItem = z.infer<typeof CharacterItemSchema>;
export type ProductItem = z.infer<typeof ProductItemSchema>;
export type SetItem = z.infer<typeof SetItemSchema>;
export type LibraryItem = z.infer<typeof LibraryItemSchema>;
export type LibraryKind = LibraryItem["kind"];

const linkBase = {
  projectId: IdSchema,
  itemId: IdSchema,
  revision: RevisionSchema,
  linkedAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

export const CharacterLinkSchema = z
  .object({
    ...linkBase,
    kind: z.literal("character"),
    wardrobe: text(300).nullable(),
    sheetAssetId: IdSchema.nullable(),
    sheetApprovedAt: TimestampSchema.nullable(),
    brokenAssetIds: z.array(IdSchema).default([]),
  })
  .strict()
  .refine(
    (link) => (link.sheetAssetId === null) === (link.sheetApprovedAt === null),
    "A reference sheet is recorded together with its approval time.",
  );
export const ProductLinkSchema = z.object({ ...linkBase, kind: z.literal("product") }).strict();
export const SetLinkSchema = z.object({ ...linkBase, kind: z.literal("set") }).strict();
export const ProjectLinkSchema = z.discriminatedUnion("kind", [CharacterLinkSchema, ProductLinkSchema, SetLinkSchema]);
export type CharacterLink = z.infer<typeof CharacterLinkSchema>;
export type ProjectLink = z.infer<typeof ProjectLinkSchema>;

export function libraryItemName(item: LibraryItem): string {
  return item.kind === "character" ? item.bible.name : item.name;
}

export function createCharacter(id: string, fields: CharacterBibleFields, now: number): CharacterItem {
  return CharacterItemSchema.parse({
    id,
    kind: "character",
    archived: false,
    brokenAssetIds: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
    bible: {
      ...CharacterBibleFieldsSchema.parse(fields),
      references: { faceAssetId: null, bodyAssetId: null, wardrobeAssetIds: [] },
      version: 1,
    },
  });
}

/** Replaces the editable bible fields; references are kept and the bible version bumps. */
export function reviseCharacterBible(item: CharacterItem, fields: CharacterBibleFields, now: number): CharacterItem {
  return CharacterItemSchema.parse({
    ...nextRevision(item, now),
    bible: {
      ...CharacterBibleFieldsSchema.parse(fields),
      references: item.bible.references,
      version: item.bible.version + 1,
    },
  });
}

export type ReferenceSlot = "face" | "body" | "voice";

/** Locks the face, body, or voice reference. Face and body take an active still image; voice takes an audio asset. */
export function setCharacterReference(
  item: CharacterItem,
  slot: ReferenceSlot,
  asset: Asset,
  now: number,
): CharacterItem {
  if (asset.state.state !== "active") fail("invalid", "Restore this file before using it as a reference.");
  if (slot === "voice") {
    if (asset.kind !== "audio") fail("invalid", "A voice reference must be an audio recording.");
  } else if (asset.kind !== "image") {
    fail("invalid", "Face and body references must be still images.");
  }
  if (slot === "body" && item.bible.references.faceAssetId === null) {
    fail("invalid", "Lock the face before choosing a body reference.");
  }
  const references = {
    ...item.bible.references,
    ...(slot === "face" ? { faceAssetId: asset.id } : slot === "body" ? { bodyAssetId: asset.id } : { voiceAssetId: asset.id }),
  };
  return CharacterItemSchema.parse({
    ...nextRevision(item, now),
    brokenAssetIds: item.brokenAssetIds.filter((id) => id !== asset.id),
    bible: { ...item.bible, references, version: item.bible.version + 1 },
  });
}

export function createProduct(id: string, fields: ProductFields, now: number): ProductItem {
  return ProductItemSchema.parse({
    id,
    kind: "product",
    archived: false,
    brokenAssetIds: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
    ...ProductFieldsSchema.parse(fields),
  });
}

export function updateProduct(item: ProductItem, fields: ProductFields, now: number): ProductItem {
  return ProductItemSchema.parse({ ...nextRevision(item, now), ...ProductFieldsSchema.parse(fields) });
}

export function createSet(id: string, fields: SetFields, now: number): SetItem {
  return SetItemSchema.parse({
    id,
    kind: "set",
    archived: false,
    brokenAssetIds: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
    ...SetFieldsSchema.parse(fields),
  });
}

export function setLibraryItemArchived<T extends LibraryItem>(item: T, archived: boolean, now: number): T {
  if (item.archived === archived) return item;
  return { ...nextRevision(item, now), archived };
}

export function linkToProject(projectId: string, item: LibraryItem, now: number): ProjectLink {
  const base = { projectId, itemId: item.id, revision: 0, linkedAt: now, updatedAt: now };
  if (item.kind === "character") {
    return CharacterLinkSchema.parse({
      ...base,
      kind: "character",
      wardrobe: null,
      sheetAssetId: null,
      sheetApprovedAt: null,
      brokenAssetIds: [],
    });
  }
  return ProjectLinkSchema.parse({ ...base, kind: item.kind });
}

/** Records the project's wardrobe. A different wardrobe withdraws the approved sheet. */
export function chooseWardrobe(link: CharacterLink, wardrobe: string, now: number): CharacterLink {
  const next = text(300).parse(wardrobe);
  if (link.wardrobe === next) return link;
  return CharacterLinkSchema.parse({
    ...nextRevision(link, now),
    wardrobe: next,
    sheetAssetId: null,
    sheetApprovedAt: null,
  });
}

/** Approves a reference sheet for this project. Requires a wardrobe and an active sheet asset from the project. */
export function approveReferenceSheet(link: CharacterLink, asset: Asset, now: number): CharacterLink {
  if (link.wardrobe === null) fail("invalid", "Choose this project's wardrobe before approving a reference sheet.");
  if (asset.kind !== "sheet") fail("invalid", "Choose a reference sheet image.");
  if (asset.state.state !== "active") fail("invalid", "Restore this sheet before approving it.");
  if (asset.projectId !== link.projectId) fail("invalid", "Choose a reference sheet made in this project.");
  if (link.sheetAssetId === asset.id) return link;
  return CharacterLinkSchema.parse({
    ...nextRevision(link, now),
    sheetAssetId: asset.id,
    sheetApprovedAt: now,
    brokenAssetIds: link.brokenAssetIds.filter((id) => id !== asset.id),
  });
}
