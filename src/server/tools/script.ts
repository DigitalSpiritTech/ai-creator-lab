/**
 * Script tools: save a versioned script, plan one shot per beat.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, text } from "@/lib/domain/common";
import { ContentPieceSchema, type Slot, planShots as planContentShots, syncShotsToScript, updateCut } from "@/lib/domain/content";
import { nextRevision } from "@/lib/domain/common";
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

export const setCutOrder = defineTool({
  name: "set_cut_order",
  description:
    "Set the order the approved clips play in the exported ad: every shot id of the content piece exactly once. assemble_ad joins clips in this order.",
  input: z
    .object({
      contentId: IdSchema,
      shotIds: z.array(IdSchema).min(1).max(8),
    })
    .strict(),
  output: ContentPieceSchema,
  run: ({ store, now }, input) =>
    store.transaction(() => {
      const content = store.content.getRequired(input.contentId);
      const ids = new Set(content.shots.map((shot) => shot.id));
      if (input.shotIds.some((id) => !ids.has(id))) fail("invalid", "Order only this content piece's shots.");
      if (input.shotIds.length === content.cut.order.length && input.shotIds.every((id, index) => id === content.cut.order[index])) return content;
      return store.content.update(updateCut(content, { order: input.shotIds }, now()));
    }),
});

const reopen = (slot: Slot): Slot => (slot.state === "approved" ? { state: "open", candidateIds: slot.candidateIds, selectedId: null } : slot);

export const resetShots = defineTool({
  name: "reset_shots",
  description:
    "Regenerate from here: withdraw the approved still and clip of one beat and every beat after it. Candidates stay, so earlier choices can be approved again.",
  input: z.object({ contentId: IdSchema, fromBeatIndex: z.number().int().positive() }).strict(),
  output: z.object({ content: ContentPieceSchema, resetBeats: z.array(z.number().int().positive()) }),
  run: ({ store, now }, input) =>
    store.transaction(() => {
      const content = store.content.getRequired(input.contentId);
      if (!content.shots.some((shot) => shot.beatIndex === input.fromBeatIndex)) fail("not_found", `Beat ${input.fromBeatIndex} has no shot in this content piece.`);
      const resetBeats = content.shots
        .filter((shot) => shot.beatIndex >= input.fromBeatIndex && (shot.still.state === "approved" || shot.clip.state === "approved"))
        .map((shot) => shot.beatIndex);
      if (resetBeats.length === 0) return { content, resetBeats };
      const next = ContentPieceSchema.parse({
        ...nextRevision(content, now()),
        shots: content.shots.map((shot) => (shot.beatIndex >= input.fromBeatIndex ? { ...shot, still: reopen(shot.still), clip: reopen(shot.clip) } : shot)),
      });
      return { content: store.content.update(next), resetBeats };
    }),
});
