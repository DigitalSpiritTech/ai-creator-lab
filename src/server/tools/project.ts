/**
 * Project tools: read the whole project state, save the brief.
 * @packageDocumentation
 */
import { z } from "zod";
import { AssetSchema } from "@/lib/domain/asset";
import { IdSchema, RevisionSchema } from "@/lib/domain/common";
import { ContentPieceSchema } from "@/lib/domain/content";
import { JobSchema } from "@/lib/domain/job";
import {
  type CharacterItem,
  CharacterItemSchema,
  type CharacterLink,
  CharacterLinkSchema,
  type ProductItem,
  ProductItemSchema,
  type SetItem,
  SetItemSchema,
} from "@/lib/domain/library";
import { BriefSchema, ProjectSchema, saveBrief } from "@/lib/domain/project";
import { ScriptSchema } from "@/lib/domain/script";
import { defineTool } from "@/server/tools/registry";
import { checkRevision } from "@/server/tools/shared";

export const ProjectStateSchema = z.object({
  project: ProjectSchema,
  characters: z.array(z.object({ item: CharacterItemSchema, link: CharacterLinkSchema })),
  products: z.array(ProductItemSchema),
  sets: z.array(SetItemSchema),
  scripts: z.array(ScriptSchema),
  contents: z.array(ContentPieceSchema),
  assets: z.array(AssetSchema),
  activeJobs: z.array(JobSchema),
});

export const getProjectState = defineTool({
  name: "get_project_state",
  description:
    "Read everything about one project: the brief, linked Library characters (with this project's wardrobe and reference sheet), products, sets, scripts, content pieces with shots, active assets (newest 200), and unfinished jobs. Call this before deciding the next step.",
  input: z.object({ projectId: IdSchema }).strict(),
  output: ProjectStateSchema,
  run: ({ store }, { projectId }) => {
    const project = store.projects.getRequired(projectId);
    const characters: { item: CharacterItem; link: CharacterLink }[] = [];
    const products: ProductItem[] = [];
    const sets: SetItem[] = [];
    for (const link of store.library.listLinks(projectId)) {
      const item = store.library.getRequired(link.itemId);
      if (item.kind === "character" && link.kind === "character") characters.push({ item, link });
      if (item.kind === "product") products.push(item);
      if (item.kind === "set") sets.push(item);
    }
    return {
      project,
      characters,
      products,
      sets,
      scripts: store.scripts.listByProject(projectId),
      contents: store.content.listByProject(projectId),
      assets: store.assets.list({ projectId, state: "active", limit: 200 }),
      activeJobs: store.jobs.listByProject(projectId).filter((job) => job.status !== "completed" && job.status !== "failed"),
    };
  },
});

export const saveBriefTool = defineTool({
  name: "save_brief",
  description:
    "Save the project brief: what is being sold (productSummary), who buys it (audience), where the ad runs (platforms, e.g. TikTok, Instagram Reels), and the tone. Replaces the previous brief.",
  input: z
    .object({
      projectId: IdSchema,
      brief: BriefSchema,
      revision: RevisionSchema.optional().describe("The project revision you read; omit to overwrite."),
    })
    .strict(),
  output: ProjectSchema,
  run: ({ store, now }, { projectId, brief, revision }) =>
    store.transaction(() => {
      const project = store.projects.getRequired(projectId);
      checkRevision(project.revision, revision, "project");
      return store.projects.update(saveBrief(project, brief, now()));
    }),
});
