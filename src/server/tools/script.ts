/**
 * Script tools: save a versioned script, plan one shot per beat.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, text } from "@/lib/domain/common";
import { ContentPieceSchema, planShots as planContentShots, syncShotsToScript } from "@/lib/domain/content";
import { fail } from "@/lib/domain/failure";
import {
  BeatInputSchema,
  ScriptChangeSchema,
  ScriptSchema,
  createScript,
  diffScripts,
  reviseScript,
} from "@/lib/domain/script";
import { defineTool } from "@/server/tools/registry";
import { checkRevision } from "@/server/tools/shared";

export const saveScript = defineTool({
  name: "save_script",
  description:
    "Save a 15 to 30 second UGC ad script as ordered beats (talking, broll, textcard), or a new version of an existing script (pass scriptId and baseVersion). Beats are numbered from 1 in the order given. Editing a beat's visual withdraws that beat's approved still and clip; editing only its spoken line or length withdraws only its clip; other edits keep approvals.",
  input: z
    .object({
      projectId: IdSchema,
      scriptId: IdSchema.optional(),
      baseVersion: z.number().int().positive().optional().describe("The script version you edited; omit to overwrite."),
      title: text(120),
      beats: z.array(BeatInputSchema).min(1).max(8),
    })
    .strict(),
  output: z.object({
    script: ScriptSchema,
    change: ScriptChangeSchema.nullable(),
    updatedContentIds: z.array(IdSchema),
  }),
  run: ({ store, now, newId }, input) =>
    store.transaction(() => {
      const time = now();
      store.projects.getRequired(input.projectId);
      if (!input.scriptId) {
        const script = store.scripts.create(createScript(newId(), input.projectId, input.title, input.beats, time));
        return { script, change: null, updatedContentIds: [] };
      }
      const current = store.scripts.getRequired(input.scriptId);
      if (current.projectId !== input.projectId) fail("invalid", "This script belongs to another project.");
      checkRevision(current.version, input.baseVersion, "script");
      const revised = reviseScript(current, input.title, input.beats, time);
      const script = store.scripts.saveVersion(revised.script);
      const updatedContentIds: string[] = [];
      for (const content of store.content.listByScript(script.id)) {
        if (content.scriptVersion !== current.version) continue;
        store.content.update(syncShotsToScript(content, script, revised.change, time, newId));
        updatedContentIds.push(content.id);
      }
      return { script, change: revised.change, updatedContentIds };
    }),
});

export const planShots = defineTool({
  name: "plan_shots",
  description:
    "Create an Ad content piece with one shot per beat of the script's current version, or (with contentId) bring an existing Ad up to the script's current version without losing approvals for unchanged beats.",
  input: z
    .object({
      projectId: IdSchema,
      scriptId: IdSchema,
      contentId: IdSchema.optional(),
      title: text(120).optional(),
    })
    .strict(),
  output: ContentPieceSchema,
  run: ({ store, now, newId }, input) =>
    store.transaction(() => {
      const time = now();
      const script = store.scripts.getRequired(input.scriptId);
      if (script.projectId !== input.projectId) fail("invalid", "This script belongs to another project.");
      if (!input.contentId) {
        return store.content.create(planContentShots(newId(), script, input.title ?? script.title, time, newId));
      }
      const content = store.content.getRequired(input.contentId);
      if (content.projectId !== input.projectId || content.scriptId !== script.id) {
        fail("invalid", "This content piece uses a different script.");
      }
      if (content.scriptVersion === script.version) return content;
      const before = store.scripts.get(script.id, content.scriptVersion);
      if (!before) fail("storage", "The script version this content piece used is missing.");
      return store.content.update(syncShotsToScript(content, script, diffScripts(before, script), time, newId));
    }),
});
