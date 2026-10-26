/**
 * Projects created from an App, with the brief that steers the assistant.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, RevisionSchema, TimestampSchema, nextRevision, text } from "@/lib/domain/common";

export const AppIdSchema = z.literal("ugc-creator");
export type AppId = z.infer<typeof AppIdSchema>;

export const BriefSchema = z
  .object({
    productSummary: text(600),
    audience: text(400),
    platforms: z.array(text(40)).min(1).max(6),
    tone: text(200),
  })
  .strict();
export type Brief = z.infer<typeof BriefSchema>;

export const ProjectSchema = z
  .object({
    id: IdSchema,
    appId: AppIdSchema,
    name: text(80),
    brief: BriefSchema.nullable(),
    revision: RevisionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectSchema = z
  .object({
    name: text(80),
    appId: AppIdSchema.default("ugc-creator"),
  })
  .strict();
export type CreateProject = z.input<typeof CreateProjectSchema>;

export function createProject(input: CreateProject, id: string, now: number): Project {
  const data = CreateProjectSchema.parse(input);
  return ProjectSchema.parse({
    id,
    appId: data.appId,
    name: data.name,
    brief: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export function saveBrief(project: Project, brief: z.input<typeof BriefSchema>, now: number): Project {
  return ProjectSchema.parse({ ...nextRevision(project, now), brief: BriefSchema.parse(brief) });
}
