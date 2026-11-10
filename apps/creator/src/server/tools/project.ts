/**
 * Project tools: read the whole project state, save the brief. Also the functions behind the
 * project routes: start a project (in an installed App, under an optional parent, optionally seeded
 * from an inbound context) and move it under another parent.
 * @packageDocumentation
 */
import { z } from "zod";
import { AssetSchema } from "@creator-lab/core/domain/asset";
import { IdSchema, RevisionSchema } from "@creator-lab/core/domain/common";
import { ContentPieceSchema } from "@creator-lab/core/domain/content";
import { JobSchema } from "@creator-lab/core/domain/job";
import { fail } from "@creator-lab/core/domain/failure";
import { InboundContextSchema, resolveLibraryRefs } from "@creator-lab/core/domain/inbound";
import {
  type CharacterItem,
  CharacterItemSchema,
  type CharacterLink,
  CharacterLinkSchema,
  type ProductItem,
  ProductItemSchema,
  type ProjectLink,
  ProjectLinkSchema,
  type SetItem,
  SetItemSchema,
  linkToProject,
} from "@creator-lab/core/domain/library";
import { PluginPieceSchema } from "@creator-lab/core/domain/piece";
import { ProjectPreferencesSchema } from "@creator-lab/core/domain/preferences";
import {
  BriefSchema,
  CreateProjectSchema,
  type Project,
  ProjectSchema,
  checkParent,
  createProject,
  saveBrief,
  setProjectParent,
} from "@creator-lab/core/domain/project";
import { ScriptSchema } from "@creator-lab/core/domain/script";
import { briefContent } from "@creator-lab/core/domain/document";
import type { PluginRegistry } from "@creator-lab/core/registry";
import { serverPlugins } from "@/plugins/server";
import { recordDocument } from "@/server/tools/documents";
import { type ToolContext, defineTool, ownerOf } from "@/server/tools/registry";
import { checkRevision } from "@/server/tools/shared";

export const ProjectStateSchema = z.object({
  project: ProjectSchema,
  characters: z.array(z.object({ item: CharacterItemSchema, link: CharacterLinkSchema })),
  products: z.array(ProductItemSchema),
  sets: z.array(SetItemSchema),
  scripts: z.array(ScriptSchema),
  contents: z.array(ContentPieceSchema),
  /** Content pieces of plugin content types (a Social Post), newest first. */
  pieces: z.array(PluginPieceSchema),
  assets: z.array(AssetSchema),
  activeJobs: z.array(JobSchema),
  /** This project's recipe preference per capability (set_recipe_preference). */
  preferences: ProjectPreferencesSchema,
});

export const getProjectState = defineTool({
  name: "get_project_state",
  description:
    "Read everything about one project: the brief, linked Library characters (with this project's wardrobe and reference sheet), products, sets, scripts, content pieces with shots (contents, the Ad) or slots (pieces, a plugin content type such as a social post), active assets (newest 200), unfinished jobs, and this project's recipe preferences. Call this before deciding the next step.",
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
      pieces: store.pieces.listByProject(projectId),
      assets: store.assets.list({ projectId, state: "active", limit: 200 }),
      activeJobs: store.jobs.listByProject(projectId).filter((job) => job.status !== "completed" && job.status !== "failed"),
      preferences: store.preferences.get(projectId),
    };
  },
});

export const saveBriefTool = defineTool({
  name: "save_brief",
  description:
    "Save the project brief: what is being sold (productSummary), who buys it (audience), where the ad runs (platforms, e.g. TikTok, Instagram Reels), and the tone. Replaces the previous brief; the previous one stays in the brief's version history.",
  input: z
    .object({
      projectId: IdSchema,
      brief: BriefSchema,
      revision: RevisionSchema.optional().describe("The project revision you read; omit to overwrite."),
    })
    .strict(),
  output: ProjectSchema,
  run: (context, { projectId, brief, revision }) =>
    context.store.transaction(() => {
      const project = context.store.projects.getRequired(projectId);
      checkRevision(project.revision, revision, "project");
      const saved = context.store.projects.update(saveBrief(project, brief, context.now()));
      recordDocument(context, "brief", saved.id, briefContent(saved.brief!));
      return saved;
    }),
});

/** What `POST /api/projects` accepts: a name, the App, an optional parent, and an optional inbound context. */
export const StartProjectSchema = CreateProjectSchema.extend({ inbound: InboundContextSchema.optional() }).strict();
export type StartProject = z.input<typeof StartProjectSchema>;

export const StartedProjectSchema = z.object({ project: ProjectSchema, links: z.array(ProjectLinkSchema) });
export type StartedProject = z.infer<typeof StartedProjectSchema>;

/** The Apps a project can be made in, from the plugin registry, for the unknown-App message. */
function installedApps(registry: Pick<PluginRegistry, "contentTypes">): string {
  const apps = new Map(registry.contentTypes().map((type) => [type.app.id, type.app.label]));
  return [...apps].map(([id, label]) => `${label} (${id})`).join(", ") || "none";
}

/**
 * Creates a project in an installed App for the context's owner. With `parentProjectId`, the parent
 * must exist, have the same owner, and not be inside this project. With `inbound`, the project is
 * seeded in the same transaction: the brief is saved as its first document version and each Library
 * item named is linked (each must exist, match its kind, and not be archived), and the origin is
 * recorded on the project. The gallery's "start from example" calls this with an example's context.
 */
export function startProject(
  context: ToolContext,
  input: StartProject,
  registry: Pick<PluginRegistry, "contentTypes" | "contentTypeForApp"> = serverPlugins,
): StartedProject {
  const data = StartProjectSchema.parse(input);
  if (!registry.contentTypeForApp(data.appId)) {
    fail("invalid", `There is no installed App "${data.appId}". Installed Apps: ${installedApps(registry)}.`);
  }
  const { store } = context;
  const ownerId = ownerOf(context);
  return store.transaction(() => {
    const id = context.newId();
    checkParent(id, data.parentProjectId, ownerId, (projectId) => store.projects.get(projectId));
    const time = context.now();
    let project = store.projects.create(
      createProject({ name: data.name, appId: data.appId, parentProjectId: data.parentProjectId }, id, time, { ownerId, origin: data.inbound?.source ?? null }),
    );
    const links: ProjectLink[] = [];
    if (data.inbound) {
      if (data.inbound.brief) {
        project = store.projects.update(saveBrief(project, data.inbound.brief, time));
        recordDocument(context, "brief", project.id, briefContent(project.brief!));
      }
      for (const item of resolveLibraryRefs(data.inbound.libraryRefs, ownerId, (itemId) => store.library.get(itemId))) {
        links.push(store.library.link(linkToProject(project.id, item, time)));
      }
    }
    return { project, links };
  });
}

/** Moves a project under another parent (or to the top with null): same owner, no cycles. */
export function moveProject(context: ToolContext, projectId: string, parentProjectId: string | null, revision?: number): Project {
  const { store } = context;
  return store.transaction(() => {
    const project = store.projects.getRequired(projectId);
    if (project.ownerId !== ownerOf(context)) fail("not_found", "This project could not be found.");
    checkRevision(project.revision, revision, "project");
    const moved = setProjectParent(project, parentProjectId, (id) => store.projects.get(id), context.now());
    return moved === project ? project : store.projects.update(moved);
  });
}
