/**
 * Documents in the project's artifact panel: the brief, a character's bible, a product card, and a
 * script. The live record (the project, the Library item, the script) stays the source of truth
 * every step reads; each saved change to its document fields is also kept as a numbered version,
 * so any earlier one can be read and restored. Scripts already keep their own version history.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, TimestampSchema, text } from "./common";
import {
  type CharacterItem,
  CharacterBibleFieldsSchema,
  type ProductItem,
  ProductFieldsSchema,
} from "./library";
import { type Brief, BriefSchema } from "./project";
import { BeatSchema, type Script } from "./script";

export const DocumentKindSchema = z.enum(["brief", "bible", "product", "script"]);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

/** Who saved a version: the assistant (chat or an MCP client) or a person in the app. Null when not recorded. */
export const DocumentAuthorSchema = z.enum(["assistant", "user"]);
export type DocumentAuthor = z.infer<typeof DocumentAuthorSchema>;

export const ScriptContentSchema = z
  .object({ title: text(120), beats: z.array(BeatSchema).min(1).max(8) })
  .strict();

const versionBase = {
  /** The project id for a brief, the Library item id for a bible or product, the script id for a script. */
  subjectId: IdSchema,
  version: z.number().int().positive(),
  author: DocumentAuthorSchema.nullable(),
  /** The version this one restored, when it was made by a restore. */
  restoredFrom: z.number().int().positive().nullable(),
  createdAt: TimestampSchema,
};

export const BriefVersionSchema = z.object({ ...versionBase, kind: z.literal("brief"), content: BriefSchema }).strict();
export const BibleVersionSchema = z
  .object({ ...versionBase, kind: z.literal("bible"), content: CharacterBibleFieldsSchema })
  .strict();
export const ProductVersionSchema = z
  .object({ ...versionBase, kind: z.literal("product"), content: ProductFieldsSchema })
  .strict();
export const ScriptVersionSchema = z
  .object({ ...versionBase, kind: z.literal("script"), content: ScriptContentSchema })
  .strict();

export const DocumentVersionSchema = z.discriminatedUnion("kind", [
  BriefVersionSchema,
  BibleVersionSchema,
  ProductVersionSchema,
  ScriptVersionSchema,
]);
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

/** The kinds kept in the document history table; script history lives with the script. */
export type StoredDocumentKind = Exclude<DocumentKind, "script">;
export type StoredDocumentVersion = Exclude<DocumentVersion, { kind: "script" }>;
export type DocumentContent<K extends DocumentKind> = Extract<DocumentVersion, { kind: K }>["content"];

export function briefContent(brief: Brief): DocumentContent<"brief"> {
  return BriefSchema.parse(brief);
}

/** The bible's editable fields; references and the bible version are managed by other steps. */
export function bibleContent(item: CharacterItem): DocumentContent<"bible"> {
  const { name, ageRange, look, build, wardrobeDefaults, voice, vibe, backstory, boundaries, visualCore } = item.bible;
  return CharacterBibleFieldsSchema.parse({ name, ageRange, look, build, wardrobeDefaults, voice, vibe, backstory, boundaries, visualCore });
}

export function productContent(item: ProductItem): DocumentContent<"product"> {
  return ProductFieldsSchema.parse({
    name: item.name,
    appearance: item.appearance,
    link: item.link,
    allowedClaims: item.allowedClaims,
    imageAssetIds: item.imageAssetIds,
  });
}

/** A script version read as a document. Script versions do not record who saved them. */
export function scriptVersionDocument(script: Script): DocumentVersion {
  return ScriptVersionSchema.parse({
    kind: "script",
    subjectId: script.id,
    version: script.version,
    author: null,
    restoredFrom: null,
    createdAt: script.updatedAt,
    content: { title: script.title, beats: script.beats },
  });
}

/** Whether two contents of the same kind say the same thing. */
export function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One line that tells versions apart in a history list. */
export function versionSummary(version: DocumentVersion): string {
  const clip = (value: string, max = 90) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
  switch (version.kind) {
    case "brief":
      return clip(`${version.content.productSummary} · ${version.content.tone}`);
    case "bible":
      return clip(`${version.content.name}: ${version.content.visualCore}`);
    case "product":
      return clip(`${version.content.name} · ${version.content.allowedClaims.length} claims · ${version.content.imageAssetIds.length} photos`);
    case "script":
      return clip(`${version.content.title} · ${version.content.beats.length} beats`);
  }
}
