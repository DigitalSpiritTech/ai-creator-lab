/**
 * The server half of the Social Post plugin: its three tools, the copy schema for its piece body,
 * and its assistant. The app registers `socialPostServerPlugin` on the server in place of the
 * data-only `socialPostPlugin` (same manifest, plus these).
 *
 * Tools, named with the plugin prefix so the core roster names stay untouched:
 * - `social_post_save_copy`: create the post or revise its copy (a versioned document).
 * - `social_post_propose_still`: propose stills for one aspect ratio through `propose_candidates`,
 *   aimed at the post's slot for that ratio; nothing runs until the gate submits it.
 * - `social_post_export`: the approved stills per aspect ratio and the copy as text.
 * Everything else is the core roster: `save_brief`, `link_library_item`, `approve` (kind `slot`),
 * `archive_asset`, `refine_still`, `list_document_versions`, `restore_document_version`.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema } from "@creator-lab/core/catalog";
import { IdSchema, RecipeIdSchema, RevisionSchema, Sha256Schema, text } from "@creator-lab/core/domain/common";
import { fail } from "@creator-lab/core/domain/failure";
import { GenerationProposalSchema } from "@creator-lab/core/domain/job";
import { type PluginPiece, PluginPieceSchema, approvedSlots, createPiece, revisePiece } from "@creator-lab/core/domain/piece";
import {
  type AssistantStage,
  type AssistantView,
  type ContentAssistantDefinition,
  type PluginToolPort,
  definePlugin,
  definePluginTool,
} from "@creator-lab/core/registry";
import {
  RATIO_LABELS,
  SOCIAL_POST_RATIOS,
  type SocialPostCopy,
  SocialPostCopyInputSchema,
  SocialPostCopySchema,
  type SocialPostRatio,
  SocialPostRatioSchema,
  copyText,
  normalizeCopy,
  titleFrom,
} from "./copy";
import { SOCIAL_POST_APP, SOCIAL_POST_CONTENT_TYPE, SOCIAL_POST_PIECE_TYPE, SOCIAL_POST_TOOLS, type SocialPostStepId, socialPostPlugin } from "./index";

/** The post's copy, parsed; a piece saved by this plugin always has one. */
export function postCopy(piece: PluginPiece): SocialPostCopy {
  return SocialPostCopySchema.parse(piece.body);
}

function requirePostProject(port: PluginToolPort, projectId: string) {
  const project = port.project(projectId);
  if (project.appId !== SOCIAL_POST_APP.id) fail("invalid", `This project was made in another App; social posts live in ${SOCIAL_POST_APP.label} projects.`);
  return project;
}

const PostOutputSchema = z.object({ post: PluginPieceSchema, created: z.boolean(), copyText: z.string() });

export const saveCopy = definePluginTool({
  name: SOCIAL_POST_TOOLS.saveCopy,
  contentType: SOCIAL_POST_CONTENT_TYPE,
  description:
    "Save a social post's copy: the caption (up to 2200 characters, hook first), hashtags (with or without #, up to 30), a call to action, and the visual line (one or two sentences describing the picture; the stills are generated from it). Without contentId it revises the project's newest post, or starts the post (with a slot per aspect ratio: 1:1, 4:5, 9:16, 16:9) when there is none; newPost starts another. Every save is a version in the copy's history (list_document_versions kind piece).",
  input: z
    .object({
      projectId: IdSchema,
      contentId: IdSchema.optional().describe("The post to revise; omit for the project's newest post."),
      newPost: z.boolean().default(false).describe("Start another post instead of revising the newest one."),
      title: text(120).optional().describe("A short name for the post; defaults to the caption's first line."),
      copy: SocialPostCopyInputSchema,
      revision: RevisionSchema.optional().describe("The post revision you read; omit to overwrite."),
    })
    .strict(),
  output: PostOutputSchema,
  run: (port, input) =>
    port.transaction(() => {
      requirePostProject(port, input.projectId);
      const copy = normalizeCopy(input.copy);
      const existing = input.contentId
        ? port.piece(input.contentId)
        : input.newPost
          ? undefined
          : port.pieces(input.projectId, SOCIAL_POST_PIECE_TYPE)[0];
      if (existing) {
        if (existing.projectId !== input.projectId) fail("invalid", "This post belongs to another project.");
        if (input.revision !== undefined && input.revision !== existing.revision) fail("conflict", "The post changed since you last read it. Read it again before saving.");
        const post = port.savePiece(revisePiece(existing, { title: input.title, body: copy }, port.now()));
        return { post, created: false, copyText: copyText(postCopy(post)) };
      }
      const post = port.createPiece(
        createPiece(
          { id: port.newId(), projectId: input.projectId, ownerId: port.ownerId, type: SOCIAL_POST_PIECE_TYPE, title: input.title ?? titleFrom(copy), slots: SOCIAL_POST_RATIOS, body: copy },
          port.now(),
        ),
      );
      return { post, created: true, copyText: copyText(postCopy(post)) };
    }),
});

/** How each ratio frames the subject, appended to the visual line. */
const FRAMING: Record<SocialPostRatio, string> = {
  "1:1": "Square composition with the subject centered and clear space around it.",
  "4:5": "Portrait 4:5 feed composition, the subject filling the upper two thirds.",
  "9:16": "Vertical 9:16 full-screen composition with calm space at the top and bottom for overlays.",
  "16:9": "Wide 16:9 composition with the subject off-center and room to breathe.",
};

/** What the still prompt reads from the project: the linked character's and product's references. */
const CastSchema = z.object({
  characters: z.array(
    z.object({
      item: z.object({ bible: z.object({ visualCore: z.string(), references: z.object({ faceAssetId: IdSchema.nullable() }) }) }),
      link: z.object({ sheetAssetId: IdSchema.nullable() }),
    }),
  ),
  products: z.array(z.object({ appearance: z.string().default(""), imageAssetIds: z.array(IdSchema) })),
});

/** The still prompt: the visual line, the references named by position, the framing, and no text in the image. */
export function stillPrompt(visual: string, ratio: SocialPostRatio, references: { product?: { image?: number; appearance: string }; person?: { image: number; visualCore: string } }): string {
  const line = visual.trim();
  const parts = [/[.!?]$/.test(line) ? line : `${line}.`];
  if (references.person) parts.push(`The person is the one in image ${references.person.image}: ${references.person.visualCore} Keep the face and look the same.`);
  if (references.product) {
    const looks = references.product.appearance.trim() || "the product";
    parts.push(references.product.image ? `The product is ${looks}, exactly as shown in image ${references.product.image}.` : `The product is ${looks}.`);
  }
  parts.push(FRAMING[ratio], "Natural light, photographic, no text, captions, watermarks, or logos in the image.");
  return parts.join(" ");
}

export const proposeStill = definePluginTool({
  name: SOCIAL_POST_TOOLS.proposeStill,
  contentType: SOCIAL_POST_CONTENT_TYPE,
  description:
    "Propose still candidates for one aspect ratio of a social post (1:1, 4:5, 9:16, or 16:9) from its visual line, with the linked character's reference sheet (or face) and product photo as references when there are any. Returns a proposal; nothing is generated until the user approves it on the card. Approve a result with approve, kind slot, the post's contentId, and the ratio as slot.",
  input: z
    .object({
      contentId: IdSchema,
      aspectRatio: SocialPostRatioSchema,
      prompt: text(4000).optional().describe("Replaces the copy's visual line for this proposal."),
      referenceAssetIds: z.array(IdSchema).max(4).optional().describe("Reference images to use instead of the linked character and product."),
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(2),
    })
    .strict(),
  output: GenerationProposalSchema,
  run: async (port, input) => {
    const post = port.piece(input.contentId);
    const copy = postCopy(post);
    const visual = input.prompt ?? copy.visual;
    if (!visual.trim()) fail("invalid", "Describe the picture first: save the post's visual line, or pass a prompt.");
    let references: string[] = input.referenceAssetIds ?? [];
    let prompt: string;
    if (input.referenceAssetIds) {
      prompt = stillPrompt(visual, input.aspectRatio, {});
    } else {
      const cast = CastSchema.parse(await port.callTool("get_project_state", { projectId: post.projectId }));
      const active = (id: string | null | undefined) => !!id && port.asset(id)?.state.state === "active";
      const person = cast.characters[0];
      const personImage = person ? [person.link.sheetAssetId, person.item.bible.references.faceAssetId].find(active) : undefined;
      const product = cast.products[0];
      const productImage = product?.imageAssetIds.find(active);
      references = [personImage, productImage].filter((id): id is string => !!id);
      prompt = stillPrompt(visual, input.aspectRatio, {
        ...(person && personImage ? { person: { image: references.indexOf(personImage) + 1, visualCore: person.item.bible.visualCore } } : {}),
        ...(product ? { product: { appearance: product.appearance, ...(productImage ? { image: references.indexOf(productImage) + 1 } : {}) } } : {}),
      });
    }
    return port.callTool("propose_candidates", {
      projectId: post.projectId,
      capability: CapabilitySchema.parse(references.length ? "image_edit" : "text_to_image"),
      ...(input.recipeId ? { recipeId: input.recipeId } : {}),
      prompt,
      referenceAssetIds: references,
      count: input.count,
      target: { kind: "piece", contentId: post.id, slot: input.aspectRatio },
      aspectRatio: input.aspectRatio,
    });
  },
});

const ExportStillSchema = z.object({
  aspectRatio: SocialPostRatioSchema,
  label: z.string(),
  assetId: IdSchema,
  mime: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  sha256: Sha256Schema,
});

export const exportPost = definePluginTool({
  name: SOCIAL_POST_TOOLS.export,
  contentType: SOCIAL_POST_CONTENT_TYPE,
  description:
    "Export a social post: its approved still for each aspect ratio (asset ids to download) and its copy as one block of text (caption, call to action, hashtags), with the ratios that have no approved still yet. Needs at least one approved still. Nothing is generated or changed.",
  input: z.object({ contentId: IdSchema }).strict(),
  output: z.object({
    contentId: IdSchema,
    projectId: IdSchema,
    title: z.string(),
    copy: SocialPostCopySchema,
    copyText: z.string(),
    stills: z.array(ExportStillSchema),
    missing: z.array(SocialPostRatioSchema),
  }),
  run: (port, input) => {
    const post = port.piece(input.contentId);
    const copy = postCopy(post);
    const approved = new Map(approvedSlots(post).map((entry) => [entry.slot, entry.assetId]));
    const stills: z.input<typeof ExportStillSchema>[] = [];
    const missing: SocialPostRatio[] = [];
    for (const ratio of SOCIAL_POST_RATIOS) {
      const asset = approved.has(ratio) ? port.asset(approved.get(ratio)!) : undefined;
      if (!asset || asset.state.state !== "active") {
        missing.push(ratio);
        continue;
      }
      stills.push({ aspectRatio: ratio, label: RATIO_LABELS[ratio], assetId: asset.id, mime: asset.mime, width: asset.width, height: asset.height, sha256: asset.sha256 });
    }
    if (stills.length === 0) fail("invalid", "Approve a still for at least one aspect ratio before exporting.");
    return { contentId: post.id, projectId: post.projectId, title: post.title, copy, copyText: copyText(copy), stills, missing };
  },
});

export const SOCIAL_POST_SYSTEM_PROMPT = `You are the Social Post assistant in AI Creator Lab, an open-source studio that runs on the creator's own Comfy account. You help a creator make one feed post: stills in up to four aspect ratios (1:1, 4:5, 9:16, 16:9) plus the copy. There is no video in a social post.

# How you work
- Propose, then let the person decide. Generation costs credits: social_post_propose_still returns a proposal card, and nothing runs until the person approves it there. Never say an image exists before it does.
- Follow the next step in the project state. One step at a time; keep replies short and plain, no hype.
- The brief comes first (save_brief): what is promoted, who it is for, where it runs, the tone.
- Reuse the Library: when the person names a character or product they already have, link it (link_library_item). Linked characters and products become the stills' references automatically. A product's allowed claims are the only claims the copy may make.
- Copy (social_post_save_copy): a caption with the hook in the first line, under 2200 characters (most land between 80 and 300); three to eight specific hashtags; one call to action; and the visual line, one or two concrete sentences a still model can render (setting, subject, light, where the product is). Never put text inside the image. Show the draft before saving unless the person said to go ahead. Edits are versions; the person can restore an earlier one.
- Stills: propose one aspect ratio at a time, 4:5 first (the feed default), then the others the person wants. The person approves one candidate per ratio (approve, kind slot, slot is the ratio); the rest are archived. refine_still edits a candidate that is close.
- Export (social_post_export) once at least one ratio is approved: list what is ready and what is missing.

# Boundaries
- No health or outcome claims beyond the product's allowed claims, no competitor names, nothing unsafe or explicit. Body shots use everyday clothing or athleticwear.
- You cannot change the monthly budget; only the person can, in Settings.`;

/** The post the assistant works on: the newest. */
function currentPost(view: AssistantView): PluginPiece | undefined {
  return view.pieces[0];
}

/** One line per slot: approved, waiting on candidates, or empty. */
function slotLine(post: PluginPiece): string {
  return SOCIAL_POST_RATIOS.map((ratio) => {
    const slot = post.slots[ratio];
    if (!slot || slot.state === "empty") return `${ratio} none`;
    if (slot.state === "approved") return `${ratio} approved (${slot.assetId})`;
    return `${ratio} ${slot.candidateIds.length} candidate(s) waiting: ${slot.candidateIds.join(", ")}`;
  }).join("; ");
}

/** The next step for a post and what to do there. Pure. */
export function socialPostStage(view: AssistantView): AssistantStage & { stepId: SocialPostStepId } {
  const post = currentPost(view);
  const state: string[] = [];
  if (post) {
    const copy = postCopy(post);
    state.push(
      `Social post "${post.title}" (contentId ${post.id}, revision ${post.revision}): caption ${copy.caption.length} characters, ${copy.hashtags.length} hashtags, call to action ${copy.callToAction ? `"${copy.callToAction}"` : "none"}.`,
      `Visual line: ${copy.visual ? `"${copy.visual}"` : "none yet"}.`,
      `Stills: ${slotLine(post)}.`,
    );
    if (view.pieces.length > 1) state.push(`Older posts in this project: ${view.pieces.slice(1).map((piece) => `"${piece.title}" (${piece.id})`).join(", ")}.`);
  } else {
    state.push("Social post: none yet.");
  }
  if (!view.project.brief) {
    return { stepId: "brief", state, guidance: "Ask what the post promotes, who it is for, where it runs, and the tone, in one short message; offer defaults. Then call save_brief. If the person names a Library character or product, link it." };
  }
  if (!post) {
    return {
      stepId: "copy",
      state,
      guidance: `Draft the caption (hook first), three to eight hashtags, a call to action, and the visual line from the brief${view.linked.length ? " and the linked Library items" : ""}. Show it, then call ${SOCIAL_POST_TOOLS.saveCopy} with the projectId.`,
    };
  }
  const copy = postCopy(post);
  if (!copy.visual) {
    return { stepId: "copy", state, guidance: `The post has no visual line yet. Suggest one or two concrete sentences for the picture and save them with ${SOCIAL_POST_TOOLS.saveCopy} (contentId ${post.id}).` };
  }
  const approved = approvedSlots(post);
  if (approved.length === 0) {
    const waiting = SOCIAL_POST_RATIOS.some((ratio) => post.slots[ratio]?.state === "open");
    return {
      stepId: "stills",
      state,
      guidance: waiting
        ? "Candidates are waiting. Ask which one to approve; approve it with approve (kind slot, contentId, slot is the ratio, assetId)."
        : `Propose the 4:5 still with ${SOCIAL_POST_TOOLS.proposeStill} (contentId ${post.id}, aspectRatio 4:5). The person approves the proposal card before anything runs.`,
    };
  }
  const missing = SOCIAL_POST_RATIOS.filter((ratio) => !approved.some((entry) => entry.slot === ratio));
  return {
    stepId: "export",
    state,
    guidance: `Approved: ${approved.map((entry) => entry.slot).join(", ")}. Offer ${missing.length ? `the other ratios (${missing.join(", ")}) with ${SOCIAL_POST_TOOLS.proposeStill}, or ` : ""}the export with ${SOCIAL_POST_TOOLS.export} (contentId ${post.id}).`,
  };
}

export const socialPostAssistant: ContentAssistantDefinition = {
  contentType: SOCIAL_POST_CONTENT_TYPE,
  systemPrompt: SOCIAL_POST_SYSTEM_PROMPT,
  stage: socialPostStage,
};

export const SOCIAL_POST_TOOL_DEFINITIONS = [saveCopy, proposeStill, exportPost];

/** The Social Post plugin with its server contributions; the app registers this one on the server. */
export const socialPostServerPlugin = definePlugin({
  ...socialPostPlugin,
  tools: SOCIAL_POST_TOOL_DEFINITIONS,
  pieces: [{ pieceType: SOCIAL_POST_PIECE_TYPE, body: SocialPostCopySchema }],
  assistants: [socialPostAssistant],
});
