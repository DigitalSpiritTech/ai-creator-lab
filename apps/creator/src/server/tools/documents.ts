/**
 * Document tools for the artifact panel: list a document's versions and restore one. The save
 * tools (`save_brief`, `save_character_bible`, `save_product`, `save_script`) write the live record
 * and append a version through `recordDocument`, so the chat and the panel read the same thing.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema } from "@creator-lab/core/domain/common";
import {
  type DocumentContent,
  DocumentKindSchema,
  DocumentVersionSchema,
  type StoredDocumentKind,
  bibleContent,
  briefContent,
  productContent,
  sameContent,
  scriptVersionDocument,
} from "@creator-lab/core/domain/document";
import { fail } from "@creator-lab/core/domain/failure";
import {
  type CharacterItem,
  type ProductItem,
  reviseCharacterBible,
  updateProduct,
} from "@creator-lab/core/domain/library";
import { revisePiece } from "@creator-lab/core/domain/piece";
import { saveBrief } from "@creator-lab/core/domain/project";
import { ScriptChangeSchema } from "@creator-lab/core/domain/script";
import type { Store } from "@/server/store";
import { type ToolContext, defineTool, ownerOf } from "@/server/tools/registry";
import { checkPieceBody, savePiece } from "@/server/tools/pieces";
import { saveScriptRevision } from "@/server/tools/script";

/** Appends a version of a document after its live record was saved. A save that changed nothing records nothing. */
export function recordDocument<K extends StoredDocumentKind>(
  context: ToolContext,
  kind: K,
  subjectId: string,
  content: DocumentContent<K>,
  restoredFrom: number | null = null,
) {
  return context.store.documents.record({
    kind,
    subjectId,
    ownerId: ownerOf(context),
    content,
    author: context.author ?? null,
    restoredFrom,
    createdAt: context.now(),
  });
}

/** The current content of a stored document, read from its live record. */
function currentContent(store: Store, kind: StoredDocumentKind, subjectId: string) {
  if (kind === "brief") {
    const brief = store.projects.getRequired(subjectId).brief;
    return brief ? briefContent(brief) : null;
  }
  if (kind === "piece") return store.pieces.getRequired(subjectId).body;
  const item = store.library.getRequired(subjectId);
  if (kind === "bible") return item.kind === "character" ? bibleContent(item) : fail("invalid", "This Library item is not a character.");
  return item.kind === "product" ? productContent(item) : fail("invalid", "This Library item is not a product.");
}

const ListInputSchema = z
  .object({
    kind: DocumentKindSchema,
    subjectId: IdSchema.describe("The project id for the brief, the Library item id for a bible or product, the script id for a script, the content piece id for a piece (a plugin content piece's body, such as its copy)."),
  })
  .strict();

export const listDocumentVersions = defineTool({
  name: "list_document_versions",
  description:
    "List every saved version of one document in the artifact panel, oldest first: the brief (subjectId is the project id), a character bible or product card (the Library item id), a script (the script id), or a plugin content piece's body such as its copy (kind piece, the content piece id). Each version says who saved it (assistant or user) and whether it restored an earlier one. current is the version the live record holds.",
  input: ListInputSchema,
  output: z.object({
    kind: DocumentKindSchema,
    subjectId: IdSchema,
    current: z.number().int().positive().nullable(),
    versions: z.array(DocumentVersionSchema),
  }),
  run: (context, { kind, subjectId }) => {
    if (kind === "script") {
      const script = context.store.scripts.getRequired(subjectId);
      return { kind, subjectId, current: script.version, versions: context.store.scripts.listVersions(subjectId).map(scriptVersionDocument) };
    }
    const versions = context.store.documents.list(kind, subjectId);
    const live = currentContent(context.store, kind, subjectId);
    const last = versions.at(-1);
    const current = live && last && sameContent(last.content, live) ? last.version : null;
    return { kind, subjectId, current, versions };
  },
});

export const restoreDocumentVersion = defineTool({
  name: "restore_document_version",
  description:
    "Restore an earlier version of a document: its content is saved again as the newest version, through the same rules as an edit, and every later step reads it. A restored bible keeps the locked face, body, and voice; a restored product card keeps only photos that are still active; a restored script withdraws approvals the way an edit would. Refused when that version is already current. Nothing is deleted, so a restore can itself be undone by restoring the version before it.",
  input: ListInputSchema.extend({ version: z.number().int().positive() }).strict(),
  output: z.object({
    document: DocumentVersionSchema,
    restoredFrom: z.number().int().positive(),
    skippedAssetIds: z.array(IdSchema),
    change: ScriptChangeSchema.nullable(),
    updatedContentIds: z.array(IdSchema),
  }),
  run: (context, { kind, subjectId, version }) =>
    context.store.transaction(() => {
      const { store, now } = context;
      const missing = () => fail("not_found", `Version ${version} of this ${kind === "bible" ? "character bible" : kind} does not exist.`);
      if (kind === "script") {
        const current = store.scripts.getRequired(subjectId);
        const source = store.scripts.get(subjectId, version) ?? missing();
        if (source.version === current.version) fail("invalid", "That version is already current.");
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const beats = source.beats.map(({ index, ...beat }) => beat);
        const saved = saveScriptRevision(context, current, source.title, beats);
        return {
          document: scriptVersionDocument(saved.script),
          restoredFrom: version,
          skippedAssetIds: [],
          change: saved.change,
          updatedContentIds: saved.updatedContentIds,
        };
      }
      const source = store.documents.get(kind, subjectId, version) ?? missing();
      if (sameContent(source.content, currentContent(store, kind, subjectId))) fail("invalid", "That version is already current.");
      const time = now();
      let skippedAssetIds: string[] = [];
      let document;
      if (source.kind === "brief") {
        const project = store.projects.update(saveBrief(store.projects.getRequired(subjectId), source.content, time));
        document = recordDocument(context, "brief", subjectId, briefContent(project.brief!), version);
      } else if (source.kind === "bible") {
        const item = store.library.getRequired(subjectId);
        if (item.kind !== "character") fail("invalid", "This Library item is not a character.");
        const saved = store.library.update(reviseCharacterBible(item as CharacterItem, source.content, time)) as CharacterItem;
        document = recordDocument(context, "bible", subjectId, bibleContent(saved), version);
      } else if (source.kind === "piece") {
        const piece = store.pieces.getRequired(subjectId);
        const saved = savePiece(context, revisePiece(piece, { body: checkPieceBody(piece.type, source.content) }, time), version);
        document = context.store.documents.latest("piece", saved.id);
      } else {
        const item = store.library.getRequired(subjectId);
        if (item.kind !== "product") fail("invalid", "This Library item is not a product.");
        const images = source.content.imageAssetIds;
        const kept = images.filter((id) => {
          const asset = store.assets.get(id);
          return asset?.kind === "image" && asset.state.state === "active";
        });
        skippedAssetIds = images.filter((id) => !kept.includes(id));
        const saved = store.library.update(updateProduct(item as ProductItem, { ...source.content, imageAssetIds: kept }, time)) as ProductItem;
        document = recordDocument(context, "product", subjectId, productContent(saved), version);
      }
      if (!document) fail("storage", "The restore was not recorded.");
      return { document, restoredFrom: version, skippedAssetIds, change: null, updatedContentIds: [] };
    }),
});
