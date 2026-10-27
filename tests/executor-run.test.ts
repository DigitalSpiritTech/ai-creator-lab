/**
 * The run orchestration against a real temporary store: idempotent admission, uncertain Router
 * submissions resolved on the next poll, retrieve then commit, the allowance gate, and recovery.
 * No network, no credits.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { type RunResult } from "@comfyorg/sdk";
import sharp from "sharp";
import type { Recipe } from "@/lib/catalog";
import { createScript } from "@/lib/domain/script";
import { planShots } from "@/lib/domain/content";
import { createJob } from "@/lib/domain/job";
import { MOCK_RECIPES, ROUTER_RECIPES, defaultRecipes } from "@/server/catalog/defaults";
import { type ExecutorSet, MockExecutor, RouterExecutor, WorkflowExecutor } from "@/server/executors";
import type { MediaPorts } from "@/server/executors/router-download";
import type { RouterModelsPort } from "@/server/executors/router";
import { type RunDeps, advanceGeneration, recoverUnfinished, runToCompletion, startGeneration } from "@/server/executors/run";
import type { WorkflowClient } from "@/server/executors/workflow";
import { importImage } from "@/server/media/images";
import { clock, ridgelineBeats, seedProject, tempStore } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../workflows", import.meta.url));
const results = JSON.parse(readFileSync(new URL("./fixtures/router/results.json", import.meta.url), "utf8"));

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mock(capability: Recipe["capability"]): Recipe {
  return MOCK_RECIPES.find((recipe) => recipe.capability === capability)!;
}

function setup(extra: { router?: RouterExecutor; workflow?: WorkflowExecutor; allowanceUsd?: number; now?: () => number } = {}) {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = extra.now ?? clock();
  const mockExecutor = new MockExecutor({ jobs: context.store.jobs, now });
  const executors: ExecutorSet = {
    mock: mockExecutor,
    router: extra.router,
    workflow: extra.workflow,
    forRecipe: (recipe) => (recipe.kind === "mock" ? mockExecutor : recipe.kind === "router" ? extra.router : extra.workflow),
  };
  const deps: RunDeps = {
    store: context.store,
    executors,
    allowanceUsd: () => extra.allowanceUsd ?? 0,
    now,
    sleep: async () => undefined,
    poster: async () => {
      throw new Error("no ffmpeg in this test");
    },
  };
  return { ...context, now, deps, project: seedProject(context.store, now) };
}

describe("run orchestration", () => {
  test("a repeated requestId returns the existing job; a different request under it is a conflict", async () => {
    const { store, deps, project } = setup();
    const request = { requestId: randomUUID(), projectId: project.id, recipe: mock("text_to_image"), input: { prompt: "Avery portrait", images: [] } };
    const first = await startGeneration(deps, request);
    assert.equal(first.kind, "started");
    const second = await startGeneration(deps, structuredClone(request));
    assert.equal(second.kind, "existing");
    assert.equal(second.kind === "existing" && second.job.id, first.kind === "started" && first.job.id);
    const changed = await startGeneration(deps, { ...request, input: { prompt: "Something else", images: [] } });
    assert.equal(changed.kind === "failed" && changed.error.code, "conflict");
    assert.equal(store.jobs.listByProject(project.id).length, 1);
  });

  test("retrieve then commit creates asset rows and attaches candidates to the shot", async () => {
    const { store, deps, now, project } = setup();
    const script = store.scripts.create(createScript(randomUUID(), project.id, "Cup holder", ridgelineBeats(), now()));
    const content = store.content.create(planShots(randomUUID(), script, "Ad", now(), randomUUID));
    const started = await startGeneration(deps, {
      requestId: randomUUID(),
      projectId: project.id,
      recipe: mock("image_to_video"),
      input: { prompt: "A bottle on a counter", images: [] },
      target: { kind: "shot", contentId: content.id, beatIndex: 2, slot: "clip" },
    });
    assert.equal(started.kind, "started");
    const done = await runToCompletion(deps, started.kind === "started" ? started.job.id : "");
    assert.equal(done.kind, "completed");
    if (done.kind !== "completed") return;
    assert.equal(done.job.status, "completed");
    assert.equal(done.assets.length, 1);
    const [asset] = done.assets;
    assert.equal(asset.kind, "storyboard");
    assert.equal(asset.relativePath, `media/${done.job.id}-0.svg`);
    assert.equal(asset.provenance.source === "generated" && asset.provenance.mock, true);
    const shot = store.content.getRequired(content.id).shots[1];
    assert.deepEqual(shot.clip, { state: "open", candidateIds: [asset.id], selectedId: null });
    assert.equal((await advanceGeneration(deps, done.job.id)).kind, "completed");
  });

  test("an uncertain Router submit resolves on the next poll and commits under the same key", async () => {
    const recipe = ROUTER_RECIPES.find((entry) => entry.id === "router-nano-banana-2.1-edit")!;
    const output = await sharp({ create: { width: 768, height: 1376, channels: 3, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer();
    const calls: string[] = [];
    const models: RouterModelsPort = {
      async run(_model, _body, options) {
        calls.push(options!.idempotencyKey!);
        if (calls.length === 1) throw new TypeError("fetch failed");
        return { kind: "json", data: results.gemini_file, requestId: "req-1", servingProvider: null, droppedParams: null, replayed: false, creditsUsed: "12.5" } as RunResult;
      },
    };
    const cdn: MediaPorts = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      get: async () => new Response(new Uint8Array(output)),
    };
    const context = tempStore();
    cleanups.push(context.cleanup);
    const now = clock();
    const router = new RouterExecutor({ jobs: context.store.jobs, models, mediaPorts: cdn, mediaRoot: context.store.dataDir, now });
    const mockExecutor = new MockExecutor({ jobs: context.store.jobs, now });
    const deps: RunDeps = {
      store: context.store,
      executors: { mock: mockExecutor, router, forRecipe: (entry) => (entry.kind === "router" ? router : mockExecutor) },
      allowanceUsd: () => 5,
      now,
      sleep: async () => undefined,
    };
    const project = seedProject(context.store, now);
    const face = await importImage(
      context.store,
      { projectId: project.id, name: "face.png", bytes: await sharp({ create: { width: 64, height: 64, channels: 3, background: "#456" } }).png().toBuffer() },
      { now: now(), newId: randomUUID },
    );
    const request = {
      requestId: randomUUID(),
      projectId: project.id,
      recipe,
      input: { prompt: "Compose the references.", images: [face.relativePath], aspectRatio: "9:16" as const },
      inputs: [{ role: "image1", assetId: face.id, sha256: face.sha256 }],
    };
    const unconfirmed = await startGeneration(deps, request);
    assert.equal(unconfirmed.kind, "needs_confirmation");
    assert.equal(context.store.jobs.listByProject(project.id).length, 0);

    const started = await startGeneration(deps, request, { confirmUnquoted: true });
    assert.equal(started.kind, "started");
    if (started.kind !== "started") return;
    assert.equal(started.job.status, "submitting");
    assert.equal(started.job.reservedUsd, 0.15);
    assert.equal((await started.settled).kind, "uncertain");
    assert.equal(context.store.jobs.getRequired(started.job.id).status, "uncertain");

    const done = await runToCompletion(deps, started.job.id);
    assert.equal(done.kind, "completed");
    if (done.kind !== "completed") return;
    assert.deepEqual(calls, [started.job.id, started.job.id]);
    assert.equal(done.job.creditsUsed, 12.5);
    assert.equal(done.assets[0].width, 768);
    assert.deepEqual(done.assets[0].provenance.source === "generated" && done.assets[0].provenance.inputs, [{ assetId: face.id, sha256: face.sha256 }]);
  });

  test("the allowance blocks a paid submit at zero before anything is admitted or sent", async () => {
    const recipes = await defaultRecipes(workflowsDir);
    const zImage = recipes.find((recipe) => recipe.id === "z-image-turbo-t2i")!;
    const sent: unknown[] = [];
    const client = {
      workflows: { fromJson: () => assert.fail("nothing is built") },
      assets: { fromFile: () => assert.fail("nothing is uploaded") },
      submit: async (...args: unknown[]) => sent.push(args),
      jobs: { get: async () => assert.fail("nothing is polled") },
    } as unknown as WorkflowClient;
    const context = tempStore();
    cleanups.push(context.cleanup);
    const workflow = new WorkflowExecutor({ jobs: context.store.jobs, client, workflowsDir });
    const { deps, project, store } = setup({ workflow, allowanceUsd: 0 });
    deps.executors = { ...deps.executors, workflow, forRecipe: (recipe) => (recipe.kind === "workflow" ? workflow : deps.executors.mock) };
    const blocked = await startGeneration(deps, { requestId: randomUUID(), projectId: project.id, recipe: zImage, input: { prompt: "A green bottle", images: [] } });
    assert.equal(blocked.kind, "blocked");
    assert.equal(blocked.kind === "blocked" && blocked.error.code, "budget");
    assert.equal(store.jobs.listByProject(project.id).length, 0);
    assert.equal(sent.length, 0);
    const free = await startGeneration(deps, { requestId: randomUUID(), projectId: project.id, recipe: mock("text_to_image"), input: { prompt: "A green bottle", images: [] } });
    assert.equal(free.kind, "started");
  });

  test("restart recovery submits an admitted job and finishes it", async () => {
    const { store, deps, now, project } = setup();
    const admitted = store.jobs.add(
      createJob({ id: randomUUID(), requestId: randomUUID(), projectId: project.id, request: { recipe: mock("text_to_image"), input: { prompt: "Avery" } } }, now()),
    ).job;
    const [step] = await recoverUnfinished(deps);
    assert.equal(step.kind, "waiting");
    assert.equal(step.job.status, "submitting");
    const done = await runToCompletion(deps, admitted.id);
    assert.equal(done.kind, "completed");
    assert.deepEqual(store.jobs.listUnfinished(), []);
  });
});
