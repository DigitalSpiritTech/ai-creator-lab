/**
 * generate_clip in first_last mode: the ending frame must be an approved still or the project's sheet,
 * the proposal carries both frames, and start mode is unchanged.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import type { CharacterItem } from "@/lib/domain/library";
import type { GenerationProposal } from "@/lib/domain/job";
import { type ToolContext, callTool, createGenerationContext } from "@/server/tools";
import { averyBible, clock, generateAssets, ridgelineBeats, seedProject, tempStore } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../workflows", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const tools: ToolContext = { store: context.store, now, newId: randomUUID, generation: createGenerationContext(context.store, { workflowsDir }) };
  return { ...context, now, tools, project: seedProject(context.store, now) };
}

async function ok<T>(tools: ToolContext, name: string, input: unknown): Promise<T> {
  const result = await callTool(tools, name, input);
  if (!result.ok) assert.fail(`${name} failed: ${result.failure.code} ${result.failure.message}`);
  return result.output as T;
}

async function refused(tools: ToolContext, name: string, input: unknown): Promise<string> {
  const result = await callTool(tools, name, input);
  assert.equal(result.ok, false, `${name} should fail`);
  return result.ok ? "" : result.failure.message;
}

/** A two-beat ad with two still candidates per beat, the first of each approved. */
async function twoApprovedStills(context: ReturnType<typeof setup>) {
  const { tools, project } = context;
  const script = await ok<{ script: { id: string } }>(tools, "save_script", { projectId: project.id, title: "Two beats", beats: ridgelineBeats().slice(0, 2) });
  const content = await ok<{ id: string }>(tools, "plan_shots", { projectId: project.id, scriptId: script.script.id });
  const stills: { approved: string; other: string }[] = [];
  for (const beatIndex of [1, 2]) {
    const proposal = await ok<GenerationProposal>(tools, "compose_still", { contentId: content.id, beatIndex, count: 2 });
    const submitted = await ok<{ results: { assetIds: string[] }[] }>(tools, "submit_proposal", { proposal, wait: true });
    const [approved, other] = submitted.results.map((result) => result.assetIds[0]);
    await ok(tools, "approve", { kind: "still", contentId: content.id, beatIndex, assetId: approved });
    stills.push({ approved, other });
  }
  return { contentId: content.id, stills };
}

function withoutId(proposal: GenerationProposal) {
  return { ...proposal, id: "" };
}

describe("generate_clip first_last mode", () => {
  test("start mode is unchanged whether mode is omitted or explicit", async () => {
    const context = setup();
    const { contentId, stills } = await twoApprovedStills(context);
    const implicit = await ok<GenerationProposal>(context.tools, "generate_clip", { contentId, beatIndex: 1 });
    const explicit = await ok<GenerationProposal>(context.tools, "generate_clip", { contentId, beatIndex: 1, mode: "start" });
    assert.deepEqual(withoutId(explicit), withoutId(implicit));
    assert.equal(implicit.capability, "image_to_video");
    assert.deepEqual(implicit.references, [{ role: "image1", assetId: stills[0].approved }]);
  });

  test("first_last proposes both frames in order and runs on the first-and-last recipe", async () => {
    const context = setup();
    const { tools, store } = context;
    const { contentId, stills } = await twoApprovedStills(context);
    const start = await ok<GenerationProposal>(tools, "generate_clip", { contentId, beatIndex: 1 });
    const proposal = await ok<GenerationProposal>(tools, "generate_clip", { contentId, beatIndex: 1, mode: "first_last", lastAssetId: stills[1].approved });
    assert.equal(proposal.capability, "first_last_to_video");
    assert.equal(proposal.recipeId, "mock-first-last-to-video", "no Comfy key in tests, so the mock stands in for ltx-2.5-flf2v");
    assert.deepEqual(proposal.references, [
      { role: "first", assetId: stills[0].approved },
      { role: "last", assetId: stills[1].approved },
    ]);
    assert.equal(proposal.prompt, start.prompt);
    assert.deepEqual(proposal.target, start.target);
    assert.equal(proposal.durationSeconds, start.durationSeconds);
    const submitted = await ok<{ results: { assetIds: string[]; job: { request: { inputs: { role: string; assetId: string }[] } } | null }[] }>(tools, "submit_proposal", { proposal, wait: true });
    const job = submitted.results[0].job!;
    assert.deepEqual(job.request.inputs.map(({ role, assetId }) => [role, assetId]), [["first", stills[0].approved], ["last", stills[1].approved]]);
    assert.equal(store.assets.getRequired(submitted.results[0].assetIds[0]).kind, "storyboard");
  });

  test("the ending frame must be an approved still or the project's sheet, and differ from the start", async () => {
    const context = setup();
    const { tools, store, now, project } = context;
    const { contentId, stills } = await twoApprovedStills(context);
    assert.match(await refused(tools, "generate_clip", { contentId, beatIndex: 1, mode: "first_last" }), /Choose the ending frame/);
    assert.match(await refused(tools, "generate_clip", { contentId, beatIndex: 1, mode: "first_last", lastAssetId: stills[1].other }), /Restore the ending frame/);
    const loose = await generateAssets(store, now, { projectId: project.id });
    assert.match(await refused(tools, "generate_clip", { contentId, beatIndex: 1, mode: "first_last", lastAssetId: loose.assetIds[0] }), /approved still in this content piece/);
    assert.match(await refused(tools, "generate_clip", { contentId, beatIndex: 1, mode: "first_last", lastAssetId: stills[0].approved }), /different image/);
    assert.match(await refused(tools, "generate_clip", { contentId, beatIndex: 1, lastAssetId: stills[1].approved }), /needs mode first_last/);

    const { character } = await ok<{ character: CharacterItem }>(tools, "save_character_bible", { projectId: project.id, bible: averyBible() });
    for (const slot of ["face", "body"] as const) {
      const generated = await generateAssets(store, now, { projectId: project.id, target: { kind: "character_reference", characterId: character.id, slot } });
      await ok(tools, "select_reference", { characterId: character.id, slot, assetId: generated.assetIds[0] });
    }
    await ok(tools, "save_character_bible", { characterId: character.id, projectId: project.id, wardrobe: "Grey athletic zip top", bible: averyBible() });
    const sheets = await generateAssets(store, now, { projectId: project.id, target: { kind: "reference_sheet", characterId: character.id } });
    assert.match(await refused(tools, "generate_clip", { contentId, beatIndex: 1, mode: "first_last", lastAssetId: sheets.assetIds[0] }), /reference sheet/);
    await ok(tools, "approve", { kind: "sheet", assetId: sheets.assetIds[0], projectId: project.id, characterId: character.id });
    const fromSheet = await ok<GenerationProposal>(tools, "generate_clip", { contentId, beatIndex: 1, mode: "first_last", lastAssetId: sheets.assetIds[0] });
    assert.deepEqual(fromSheet.references.map((reference) => reference.assetId), [stills[0].approved, sheets.assetIds[0]]);
  });
});
