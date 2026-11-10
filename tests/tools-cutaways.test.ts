/**
 * Take-then-cutaways tools (v0.2 F5) against a temp database: what generate_take, transcribe_take,
 * and save_edl refuse and why, the planned Whisper recipes, the take prompt, and migration 9.
 * The full render with real media is in assembly-cutaways.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { PlannedRecipeSchema, RouterRecipeSchema } from "@creator-lab/core/catalog";
import { buildRouterBody, lengthSubject } from "@creator-lab/executors/router-body";
import { renderPrompt } from "@creator-lab/recipes/render";
import { addTakeCandidates } from "@creator-lab/core/domain/content";
import type { GenerationProposal } from "@creator-lab/core/domain/job";
import { CLOUD_WHISPER_ID, PLANNED_TRANSCRIPTION_RECIPES, ROUTER_WHISPER_ID } from "@creator-lab/recipes/transcription";
import { DATABASE_FILE, openStore } from "@/server/store";
import { MIGRATIONS } from "@/server/store/migrations";
import { type ToolContext, callTool, createGenerationContext } from "@/server/tools";
import { importClip } from "./support/assembly-fixtures";
import { CUTAWAY_BEATS } from "./support/cutaway-fixtures";
import { clock, seedProject, tempDir, tempStore } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../packages/recipes/workflows", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(options: { mocks?: boolean } = {}) {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const base = createGenerationContext(context.store, { workflowsDir });
  const recipes = options.mocks === false ? async () => (await base.recipes()).filter((recipe) => recipe.kind !== "mock") : base.recipes;
  const tools: ToolContext = { store: context.store, now, newId: randomUUID, generation: { ...base, recipes } };
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

async function plannedAd(context: ReturnType<typeof setup>) {
  const script = await ok<{ script: { id: string } }>(context.tools, "save_script", { projectId: context.project.id, title: "Cup holder", beats: CUTAWAY_BEATS });
  return ok<{ id: string }>(context.tools, "plan_shots", { projectId: context.project.id, scriptId: script.script.id });
}

describe("the Whisper recipes", () => {
  test("both are planned: unverified, with a ceiling and what is pending, never in the runnable catalog", async () => {
    assert.deepEqual(PLANNED_TRANSCRIPTION_RECIPES.map((recipe) => recipe.id), [ROUTER_WHISPER_ID, CLOUD_WHISPER_ID]);
    for (const recipe of PLANNED_TRANSCRIPTION_RECIPES) {
      PlannedRecipeSchema.parse(recipe);
      assert.equal(recipe.verified, null);
      assert.ok(recipe.ceilingUsd > 0);
      assert.equal(recipe.capability, "speech_to_text");
    }
    assert.match(PLANNED_TRANSCRIPTION_RECIPES[1].pending, /node choice is pending verification/);
    const context = setup();
    const listed = await ok<{ recipes: { id: string }[]; planned: { id: string; pending: string }[] }>(context.tools, "list_recipes", { capability: "speech_to_text" });
    assert.deepEqual(listed.recipes.map((recipe) => recipe.id), ["mock-speech-to-text"]);
    assert.deepEqual(listed.planned.map((recipe) => recipe.id), [ROUTER_WHISPER_ID, CLOUD_WHISPER_ID]);
  });

  test("transcribe_take names what a planned recipe is waiting for, and says so when nothing can run", async () => {
    const context = setup({ mocks: false });
    const ad = await plannedAd(context);
    assert.match(await refused(context.tools, "transcribe_take", { contentId: ad.id, recipeId: ROUTER_WHISPER_ID }), /Whisper on Comfy Router cannot run yet: No Whisper model is in the Router catalog/);
    assert.match(await refused(context.tools, "transcribe_take", { contentId: ad.id }), /No transcription recipe can run here\. Whisper on Comfy Router is not ready yet .* Whisper \(open weights\) on Comfy Cloud is not ready yet/);
  });
});

describe("take-then-cutaways tools", () => {
  test("generate_take needs an approved still on the first talking beat and speaks every line", async () => {
    const context = setup();
    const ad = await plannedAd(context);
    assert.match(await refused(context.tools, "generate_take", { contentId: ad.id }), /Approve a still for beat 1, the first talking beat/);
    const proposal = await ok<GenerationProposal>(context.tools, "compose_still", { contentId: ad.id, beatIndex: 1, count: 1 });
    const submitted = await ok<{ results: { assetIds: string[] }[] }>(context.tools, "submit_proposal", { proposal, wait: true });
    await ok(context.tools, "approve", { kind: "still", contentId: ad.id, beatIndex: 1, assetId: submitted.results[0].assetIds[0] });
    const take = await ok<GenerationProposal>(context.tools, "generate_take", { contentId: ad.id, recipeId: "mock-image-to-video" });
    assert.equal(take.spec?.kind, "take");
    assert.equal(take.spec?.kind === "take" && take.spec.lines.length, 4);
    // 8 s on a 5 s mock model: item 11's length strategy chains it, the lines shared out across segments.
    assert.equal(take.durationSeconds, 8);
    assert.match(take.estimate.note, /Chained recording: 2 segments/);
    assert.equal((take.prompt.match(/\[Segment \d of 2/g) ?? []).length, 2);
    assert.match(take.prompt, /"This fits my cup holder\. Warm by noon,/);
    assert.match(take.prompt, /Still cold a day later\. Link below\."/);
    // Within one run the house take paragraph is used as it is.
    const single = renderPrompt(take.spec!, { id: "ltx-2.5-i2v", kind: "workflow" } as Parameters<typeof renderPrompt>[1]);
    assert.ok(single.ok && /one continuous take.*"This fits my cup holder\." "Warm by noon, every day\." "Still cold a day later\." "Link below\."/.test(single.prompt));
  });

  test("transcribe_take and save_edl need an approved take and its transcript first", async () => {
    const context = setup();
    const ad = await plannedAd(context);
    assert.match(await refused(context.tools, "transcribe_take", { contentId: ad.id }), /Approve a talking recording/);
    assert.match(await refused(context.tools, "save_edl", { contentId: ad.id }), /Approve a talking recording/);
    assert.match(await refused(context.tools, "save_edl", { contentId: ad.id, windows: [] }), /no edit decision list yet/);
    const clip = await importClip(context.store, context.project.id, { color: "blue", width: 360, height: 640, rate: 24, seconds: 2, audio: true }, context.now());
    context.store.content.update(addTakeCandidates(context.store.content.getRequired(ad.id), [clip.id], context.now()));
    const approved = await ok<{ content: { take: { state: string } } }>(context.tools, "approve", { kind: "take", contentId: ad.id, assetId: clip.id });
    assert.equal(approved.content.take.state, "approved");
    assert.match(await refused(context.tools, "save_edl", { contentId: ad.id }), /Transcribe the approved recording first/);
    assert.match(await refused(context.tools, "save_edl", { contentId: ad.id, draft: true, windows: [] }), /not both/);
    const transcribe = await ok<GenerationProposal>(context.tools, "transcribe_take", { contentId: ad.id });
    assert.equal(transcribe.estimate.kind, "free");
    assert.equal(transcribe.prompt, "This fits my cup holder. Warm by noon, every day. Still cold a day later. Link below.", "the script's lines as Whisper's vocabulary");
    assert.match(await refused(context.tools, "assemble_ad", { contentId: ad.id, strategy: "take_cutaways" }), /Draft the edit decision list/);
    assert.match(await refused(context.tools, "archive_asset", { assetId: clip.id }), /approved/);

    // Draft from the mock transcript, then approve another recording: edits to the old list are refused.
    const submitted = await ok<{ results: { assetIds: string[] }[] }>(context.tools, "submit_proposal", { proposal: transcribe, wait: true });
    assert.equal(submitted.results[0].assetIds.length, 1);
    const drafted = await ok<{ edl: { windows: unknown[] }; version: number; estimated: number[] }>(context.tools, "save_edl", { contentId: ad.id });
    assert.equal(drafted.version, 1);
    assert.deepEqual(drafted.estimated, [], "every line was heard");
    const other = await importClip(context.store, context.project.id, { color: "red", width: 360, height: 640, rate: 24, seconds: 2, audio: true }, context.now());
    context.store.content.update(addTakeCandidates(context.store.content.getRequired(ad.id), [other.id], context.now()));
    await ok(context.tools, "approve", { kind: "take", contentId: ad.id, assetId: other.id, archiveSiblings: false });
    assert.match(await refused(context.tools, "save_edl", { contentId: ad.id, windows: [] }), /drafted for another recording\. Draft it again .*\(draft true\)/);
  });

  test("a recording-with-cutaways export without an approved recording says to approve one first", async () => {
    const context = setup();
    const ad = await plannedAd(context);
    const message = await refused(context.tools, "assemble_ad", { contentId: ad.id, strategy: "take_cutaways", exportId: randomUUID() });
    assert.match(message, /Approve a talking recording/);
  });

  test("generate_take chains a recording longer than the recipe's runs, on that recipe's own lengths", async () => {
    const context = setup();
    const ad = await plannedAd(context);
    const proposal = await ok<GenerationProposal>(context.tools, "compose_still", { contentId: ad.id, beatIndex: 1, count: 1 });
    const submitted = await ok<{ results: { assetIds: string[] }[] }>(context.tools, "submit_proposal", { proposal, wait: true });
    await ok(context.tools, "approve", { kind: "still", contentId: ad.id, beatIndex: 1, assetId: submitted.results[0].assetIds[0] });
    // A stand-in hosted model that makes 5 s clips only, run by the mock executor and placed without backends.
    const fiveSeconds = RouterRecipeSchema.parse({
      id: "router-five-second-i2v",
      kind: "router",
      title: "Five-second clips",
      capability: "image_to_video",
      openWeights: false,
      verified: "2026-11-10",
      costHint: "Free stand-in.",
      limits: { durations: [5], maxReferences: 1 },
      defaults: { durationSeconds: 5 },
      provider: "test",
      model: "test/five-seconds",
      fieldMap: { prompt: { path: "prompt" }, images: { path: "image", mode: "set", encoding: "base64", item: "{data}", min: 1, max: 1 }, duration: { path: "duration" } },
    });
    const generation = context.tools.generation!;
    const mock = generation.executors.mock;
    const tools: ToolContext = {
      ...context.tools,
      generation: {
        ...generation,
        routing: undefined,
        recipes: async () => [...(await generation.recipes()), fiveSeconds],
        executors: { ...generation.executors, forRecipe: (recipe) => ((recipe as { id?: string }).id === fiveSeconds.id || recipe.kind === "mock" ? mock : generation.executors.forRecipe(recipe)) },
      },
    };
    const chained = await ok<GenerationProposal>(tools, "generate_take", { contentId: ad.id, recipeId: fiveSeconds.id });
    assert.equal(chained.recipeId, fiveSeconds.id);
    assert.match(chained.estimate.note, /Chained recording: 2 segments of 5\.00 s/);
    const tooLong = { ...fiveSeconds, limits: { ...fiveSeconds.limits, durations: [0.5] } };
    const refusing: ToolContext = { ...tools, generation: { ...tools.generation!, recipes: async () => [...(await generation.recipes()), tooLong] } };
    assert.match(await refused(refusing, "generate_take", { contentId: ad.id, recipeId: tooLong.id }), /This talking recording is 8 s\./);
  });

  test("a Router length refusal names the recording, not a beat", () => {
    assert.equal(lengthSubject("take"), "this recording");
    assert.equal(lengthSubject("clip"), "this beat");
    const kling = RouterRecipeSchema.parse({
      id: "router-length-check",
      kind: "router",
      title: "Length check",
      capability: "image_to_video",
      openWeights: false,
      verified: null,
      costHint: "",
      limits: { durations: [5, 10] },
      provider: "test",
      model: "test/length",
      fieldMap: { prompt: { path: "prompt" }, duration: { path: "duration" } },
    });
    assert.throws(() => buildRouterBody(kling, { prompt: "p", images: [], durationSeconds: 20 }, [], lengthSubject("take")), /Length check makes clips of 5, 10 seconds; this recording is 20 s\./);
  });
});

describe("migration 10", () => {
  test("a version 9 database gains the edl document kind and keeps every earlier version", () => {
    const dir = tempDir();
    const raw = new DatabaseSync(join(dir, DATABASE_FILE));
    MIGRATIONS.slice(0, 9).forEach((migration, index) => {
      raw.exec(migration);
      raw.exec(`PRAGMA user_version = ${index + 1}`);
    });
    const brief = { kind: "brief", subjectId: randomUUID(), version: 1, author: "user", restoredFrom: null, createdAt: 1, ownerId: "local", content: { productSummary: "Bottle", audience: "Commuters", platforms: ["TikTok"], tone: "Warm" } };
    raw.prepare("INSERT INTO document_versions(kind, subject_id, version, data) VALUES (?, ?, ?, ?)").run("brief", brief.subjectId, 1, JSON.stringify(brief));
    assert.throws(() => raw.prepare("INSERT INTO document_versions(kind, subject_id, version, data) VALUES ('edl', 'x', 1, '{\"kind\":\"edl\",\"subjectId\":\"x\",\"version\":1}')").run(), /CHECK/);
    raw.close();
    const store = openStore(dir);
    cleanups.push(() => store.close());
    assert.equal(Object.values(store.database.prepare("PRAGMA user_version").get()!)[0], 10);
    assert.equal(store.documents.list("brief", brief.subjectId).length, 1, "earlier versions are copied as they were");
    store.database.prepare("INSERT INTO document_versions(kind, subject_id, version, data) VALUES ('edl', 'x', 1, '{\"kind\":\"edl\",\"subjectId\":\"x\",\"version\":1}')").run();
  });
});
