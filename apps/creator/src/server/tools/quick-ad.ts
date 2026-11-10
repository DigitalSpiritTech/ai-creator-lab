/**
 * The Quick Ad (v0.2 F11) as one tool: `start_quick_ad` turns a two-line brief into the project's
 * brief, a one-beat talking script, and an Ad in quick mode, in one transaction. It spends nothing;
 * the frame (`compose_still`, one candidate) and the clip (`generate_clip`) are proposals that go
 * through the spend gate as usual, and the three approvals (the frame, the clip, the export) stay
 * a person's clicks.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema } from "@creator-lab/core/domain/common";
import { ContentPieceSchema, planShots } from "@creator-lab/core/domain/content";
import { briefContent } from "@creator-lab/core/domain/document";
import { fail } from "@creator-lab/core/domain/failure";
import { ProjectSchema, saveBrief } from "@creator-lab/core/domain/project";
import {
  QUICK_AD,
  QuickAdInputSchema,
  defaultOnScreenText,
  quickAdBeat,
  quickAdPlan,
  quickBrief,
} from "@creator-lab/core/domain/quick-ad";
import { ScriptSchema, createScript } from "@creator-lab/core/domain/script";
import type { Store } from "@/server/store";
import { recordDocument } from "@/server/tools/documents";
import { defineTool, ownerOf } from "@/server/tools/registry";

/** What the project can compose the frame from: a linked character's sheet or face, a linked product and its photo. */
export function quickAdReferences(store: Store, projectId: string): { character: boolean; product: boolean; productPhoto: boolean } {
  let character = false;
  let product = false;
  let productPhoto = false;
  for (const link of store.library.listLinks(projectId)) {
    const item = store.library.get(link.itemId);
    if (!item || item.archived) continue;
    if (item.kind === "character" && link.kind === "character" && (link.sheetAssetId || item.bible.references.faceAssetId)) character = true;
    if (item.kind === "product") {
      product = true;
      if (item.imageAssetIds.some((id) => store.assets.get(id)?.state.state === "active")) productPhoto = true;
    }
  }
  return { character, product, productPhoto };
}

const StepSchema = z.object({ capability: z.string(), count: z.number().int().positive() });

export const startQuickAd = defineTool({
  name: "start_quick_ad",
  description:
    "Start a Quick Ad from two lines: what is being sold (productSummary) and who it is for (audience). Saves the brief (Quick Ad platforms and tone unless given), a one-beat talking script of four seconds (the spoken line and caption default from the first line), and an Ad in quick mode, in one step; nothing is generated. Then propose the frame with compose_still (contentId, beatIndex 1, count 1), the clip with generate_clip once the frame is approved, and assemble_ad once the clip is approved: three approvals in all. A linked Library character and product (with a photo) make the frame a composition from their images.",
  input: QuickAdInputSchema.extend({ projectId: IdSchema }).strict(),
  output: z.object({
    project: ProjectSchema,
    script: ScriptSchema,
    content: ContentPieceSchema,
    /** The two generations to propose next, by capability, one candidate each. */
    plan: z.object({ frame: StepSchema, clip: StepSchema.extend({ durationSeconds: z.number().positive() }) }),
  }),
  run: (context, { projectId, ...input }) =>
    context.store.transaction(() => {
      const { store } = context;
      const time = context.now();
      const current = store.projects.getRequired(projectId);
      if (current.ownerId !== ownerOf(context)) fail("not_found", "This project could not be found.");
      const references = quickAdReferences(store, projectId);
      const project = store.projects.update(saveBrief(current, quickBrief(input), time));
      recordDocument(context, "brief", project.id, briefContent(project.brief!));
      const beat = quickAdBeat(input, { character: references.character, product: references.product });
      const title = input.title ?? `Quick Ad: ${defaultOnScreenText(input.brief.productSummary) || "untitled"}`.slice(0, 120);
      const script = store.scripts.create(createScript(context.newId(), projectId, title, [beat], time));
      const content = store.content.create(planShots(context.newId(), script, title, time, context.newId, "quick"));
      if (content.shots.length !== QUICK_AD.beats) fail("storage", "A Quick Ad has one shot.");
      return { project, script, content, plan: quickAdPlan({ creator: references.character, productPhoto: references.productPhoto }) };
    }),
});
