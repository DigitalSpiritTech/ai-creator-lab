/**
 * Projects created from an App, with the brief that steers the assistant, the owner, an optional
 * parent project, and where the project came from when something outside seeded it.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, RevisionSchema, TimestampSchema, nextRevision, text } from "./common";
import { fail } from "./failure";
import { DEFAULT_OWNER_ID, OwnerIdSchema, ownerField } from "./owner";

/**
 * The App a project was made in: a registered App id (`ugc-creator`). The shape is checked here;
 * whether the App is installed is checked against the plugin registry where projects are created,
 * so a project from an App that was removed still opens (and says so).
 */
export const AppIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use an App id: lowercase letters, digits, and hyphens.");
export type AppId = z.infer<typeof AppIdSchema>;

/** The App a project is made in when the request names none. */
export const DEFAULT_APP_ID = "ugc-creator";

export const BriefSchema = z
  .object({
    productSummary: text(600),
    audience: text(400),
    platforms: z.array(text(40)).min(1).max(6),
    tone: text(200),
  })
  .strict();
export type Brief = z.infer<typeof BriefSchema>;

/**
 * Where a seeded project came from: a gallery example ("start from example"), an import, or an API
 * caller, with that source's own reference (an example id, a file name).
 */
export const ProjectOriginSchema = z
  .object({
    kind: z.enum(["gallery", "import", "api"]),
    ref: text(200),
  })
  .strict();
export type ProjectOrigin = z.infer<typeof ProjectOriginSchema>;

/** How deep a chain of parent projects may go. */
export const MAX_PROJECT_DEPTH = 16;

export const ProjectSchema = z
  .object({
    id: IdSchema,
    ...ownerField,
    appId: AppIdSchema,
    name: text(80),
    brief: BriefSchema.nullable(),
    /** The project this one belongs under (a campaign and its pieces), or null. */
    parentProjectId: IdSchema.nullable().default(null),
    /** Set when an inbound context seeded the project. */
    origin: ProjectOriginSchema.nullable().default(null),
    revision: RevisionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .refine((project) => project.parentProjectId !== project.id, "A project cannot be its own parent.");
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectSchema = z
  .object({
    name: text(80),
    appId: AppIdSchema.default(DEFAULT_APP_ID),
    parentProjectId: IdSchema.nullable().default(null),
  })
  .strict();
export type CreateProject = z.input<typeof CreateProjectSchema>;

export interface CreateProjectOptions {
  /** The owner from the request context; the default owner when absent. */
  ownerId?: string;
  origin?: ProjectOrigin | null;
}

/**
 * A new project. A parent named in `input` must already have been checked with `checkParent`
 * (this function cannot see other projects).
 */
export function createProject(input: CreateProject, id: string, now: number, options: CreateProjectOptions = {}): Project {
  const data = CreateProjectSchema.parse(input);
  return ProjectSchema.parse({
    id,
    ownerId: OwnerIdSchema.parse(options.ownerId ?? DEFAULT_OWNER_ID),
    appId: data.appId,
    name: data.name,
    brief: null,
    parentProjectId: data.parentProjectId,
    origin: options.origin ?? null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export function saveBrief(project: Project, brief: z.input<typeof BriefSchema>, now: number): Project {
  return ProjectSchema.parse({ ...nextRevision(project, now), brief: BriefSchema.parse(brief) });
}

/**
 * Checks that `parentId` may be the parent of project `projectId` owned by `ownerId`: it exists, has
 * the same owner, is not the project itself or one of its descendants (no cycles), and the chain
 * stays within `MAX_PROJECT_DEPTH`. `lookup` reads a project by id.
 */
export function checkParent(
  projectId: string,
  parentId: string | null,
  ownerId: string,
  lookup: (id: string) => Pick<Project, "id" | "ownerId" | "parentProjectId"> | undefined,
): void {
  if (parentId === null) return;
  if (parentId === projectId) fail("invalid", "A project cannot be its own parent.");
  const parent = lookup(parentId);
  if (!parent || parent.ownerId !== ownerId) fail("not_found", "The parent project could not be found.");
  let current: Pick<Project, "id" | "ownerId" | "parentProjectId"> | undefined = parent;
  for (let depth = 1; current; depth += 1) {
    if (current.id === projectId) fail("invalid", "That parent is inside this project already; a project cannot contain itself.");
    if (depth >= MAX_PROJECT_DEPTH) fail("invalid", `Projects nest at most ${MAX_PROJECT_DEPTH} deep.`);
    current = current.parentProjectId ? lookup(current.parentProjectId) : undefined;
  }
}

/** Moves a project under another parent (or to the top with null), after `checkParent`. */
export function setProjectParent(
  project: Project,
  parentId: string | null,
  lookup: (id: string) => Pick<Project, "id" | "ownerId" | "parentProjectId"> | undefined,
  now: number,
): Project {
  if (project.parentProjectId === parentId) return project;
  checkParent(project.id, parentId, project.ownerId, lookup);
  return ProjectSchema.parse({ ...nextRevision(project, now), parentProjectId: parentId });
}
