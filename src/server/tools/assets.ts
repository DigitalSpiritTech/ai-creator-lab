/**
 * Approval and asset lifecycle tools: approve, archive or restore, delete everywhere, list.
 * @packageDocumentation
 */
import { z } from "zod";
import { AssetKindSchema, AssetSchema } from "@/lib/domain/asset";
import { IdSchema, RecipeIdSchema, text } from "@/lib/domain/common";
import { ContentPieceSchema, approveCandidate } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import { CharacterLinkSchema, approveReferenceSheet } from "@/lib/domain/library";
import { AssetUsageSchema } from "@/lib/domain/usage";
import { archiveStoredAsset, deleteAssetEverywhere, restoreStoredAsset } from "@/server/media/lifecycle";
import { defineTool } from "@/server/tools/registry";
import { archiveUnselected, jobSiblings, requireActiveAsset } from "@/server/tools/shared";

const ApproveInputSchema = z
  .object({
    kind: z.enum(["still", "clip", "voice", "sheet"]).describe("still, clip, or voice (a voice-over take) for a beat's shot; sheet for a project's character reference sheet."),
    assetId: IdSchema,
    contentId: IdSchema.optional().describe("Required for still and clip."),
    beatIndex: z.number().int().positive().optional().describe("Required for still and clip; beats start at 1."),
    projectId: IdSchema.optional().describe("Required for sheet."),
    characterId: IdSchema.optional().describe("Required for sheet."),
    archiveSiblings: z.boolean().default(true),
  })
  .strict()
  .superRefine((input, context) => {
    const needed = input.kind === "sheet" ? (["projectId", "characterId"] as const) : (["contentId", "beatIndex"] as const);
    for (const key of needed) {
      if (input[key] === undefined) context.addIssue({ code: "custom", message: `${key} is required for ${input.kind}.`, path: [key] });
    }
  });

export const approve = defineTool({
  name: "approve",
  description:
    "Approve one candidate: a beat's still, a beat's clip (needs an approved still), a beat's voice-over take, or a project's character reference sheet (needs a wardrobe). The other candidates are archived with the reason 'not selected' unless archiveSiblings is false.",
  input: ApproveInputSchema,
  output: z.object({
    content: ContentPieceSchema.nullable(),
    link: CharacterLinkSchema.nullable(),
    archivedAssetIds: z.array(IdSchema),
  }),
  run: ({ store, now }, input) =>
    store.transaction(() => {
      const time = now();
      if (input.kind === "sheet") {
        const asset = requireActiveAsset(store, input.assetId, ["sheet"]);
        const link = store.library.getLink(input.projectId!, input.characterId!);
        if (!link || link.kind !== "character") fail("not_found", "This character is not linked to the project.");
        const saved = store.library.updateLink(approveReferenceSheet(link, asset, time));
        if (saved.kind !== "character") fail("storage", "The saved link is not a character link.");
        const archivedAssetIds = input.archiveSiblings ? archiveUnselected(store, jobSiblings(store, asset), time) : [];
        return { content: null, link: saved, archivedAssetIds };
      }
      const kinds = input.kind === "still" ? (["image"] as const) : input.kind === "voice" ? (["audio"] as const) : (["video", "storyboard"] as const);
      const asset = requireActiveAsset(store, input.assetId, [...kinds]);
      const content = store.content.getRequired(input.contentId!);
      const result = approveCandidate(content, input.beatIndex!, input.kind, asset.id, time);
      const saved = result.content === content ? content : store.content.update(result.content);
      const archivedAssetIds = input.archiveSiblings ? archiveUnselected(store, result.siblingIds, time) : [];
      return { content: saved, link: null, archivedAssetIds };
    }),
});

export const archiveAssetTool = defineTool({
  name: "archive_asset",
  description:
    "Move an asset to the Archive (restorable), or restore it with restore: true. Approved references, sheets, and shots cannot be archived until they are replaced.",
  input: z
    .object({
      assetId: IdSchema,
      reason: text(200).default("Archived by user"),
      restore: z.boolean().default(false),
    })
    .strict(),
  output: AssetSchema,
  run: ({ store, now }, input) =>
    input.restore ? restoreStoredAsset(store, input.assetId) : archiveStoredAsset(store, input.assetId, input.reason, now()),
});

export const deleteAssetEverywhereTool = defineTool({
  name: "delete_asset_everywhere",
  description:
    "Permanently delete an asset's file and remove it from every Library item, reference sheet, shot, and export that uses it; those are marked broken. Only after the user explicitly confirms. Refused when an export depends on the asset unless force is true, which also needs the user's explicit confirmation.",
  input: z
    .object({
      assetId: IdSchema,
      confirm: z.literal(true).describe("Must be true: the user confirmed this deletion."),
      force: z.boolean().default(false),
    })
    .strict(),
  output: z.object({ asset: AssetSchema, usage: z.array(AssetUsageSchema) }),
  run: ({ store, now }, input) => deleteAssetEverywhere(store, input.assetId, { force: input.force, now: now() }),
});

export const listAssets = defineTool({
  name: "list_assets",
  description: "List assets, newest first, filtered by project, kind, state (active by default), or recipe.",
  input: z
    .object({
      projectId: IdSchema.optional(),
      kind: AssetKindSchema.optional(),
      state: z.enum(["active", "archived", "deleted", "any"]).default("active"),
      recipeId: RecipeIdSchema.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  output: z.object({ assets: z.array(AssetSchema) }),
  run: ({ store }, input) => ({ assets: store.assets.list(input) }),
});
