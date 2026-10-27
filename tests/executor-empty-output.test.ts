/**
 * Black or empty outputs: the luma check in output verification, and the one automatic retry with a
 * new seed in the run orchestration. No network, no credits.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";
import { type RunResult } from "@comfyorg/sdk";
import sharp from "sharp";
import { ROUTER_RECIPES } from "@/server/catalog/defaults";
import { MockExecutor, RouterExecutor } from "@/server/executors";
import { ExecutorFailure } from "@/server/executors/jobs";
import { commitOutput, EMPTY_OUTPUT_MESSAGE, EMPTY_OUTPUT_NOTICE, looksEmpty, sampleLuma } from "@/server/executors/media";
import type { MediaPorts } from "@/server/executors/router-download";
import type { RouterModelsPort } from "@/server/executors/router";
import { type RunDeps, retryNotice, retryRequestId, runToCompletion, startGeneration } from "@/server/executors/run";
import { importImage } from "@/server/media/images";
import { clock, seedProject, tempStore } from "./support/domain-fixtures";

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const results = JSON.parse(readFileSync(new URL("./fixtures/router/results.json", import.meta.url), "utf8"));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acl-empty-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function mp4(path: string, source: string): Promise<string> {
  await run(ffmpeg, [
    "-nostdin", "-v", "error", "-f", "lavfi", "-i", `${source}:s=576x1024:r=24`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-frames:v", "121", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "mp4", path,
  ]);
  return path;
}

async function rejectsEmpty(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ExecutorFailure);
    assert.deepEqual(error.failure, { code: "provider", message: EMPTY_OUTPUT_MESSAGE, retryable: true, providerCode: "empty_output" });
    return true;
  });
}

describe("output content check", () => {
  test("a black H.264 clip with audio fails, and a testsrc clip passes", async () => {
    const directory = await temp();
    const black = await mp4(join(directory, "black.mp4.tmp"), "color=c=black");
    const samples = await sampleLuma(black, 121);
    assert.equal(samples.length, 5);
    assert.ok(samples.every((sample) => sample.avg < 1));
    await rejectsEmpty(commitOutput(black, join(directory, "black.mp4"), "media/black.mp4", { media: "video", width: 576, height: 1024, frames: 121, fps: 24 }));
    assert.deepEqual((await readdir(directory)).sort(), [], "the black clip is removed, not committed");

    const normal = await mp4(join(directory, "normal.mp4.tmp"), "testsrc=d=6");
    const saved = await commitOutput(normal, join(directory, "normal.mp4"), "media/normal.mp4", { media: "video", width: 576, height: 1024, frames: 121, fps: 24 });
    assert.deepEqual([saved.mime, saved.video?.frames, saved.video?.hasAudio], ["video/mp4", 121, true]);
  });

  test("a black PNG and a flat grey PNG fail; a textured PNG passes", async () => {
    const directory = await temp();
    const black = join(directory, "black.tmp");
    await sharp({ create: { width: 256, height: 256, channels: 3, background: "#000" } }).png().toFile(black);
    await rejectsEmpty(commitOutput(black, join(directory, "black.png"), "media/black.png", { media: "image" }));
    const grey = join(directory, "grey.tmp");
    await sharp({ create: { width: 256, height: 256, channels: 3, background: "#808080" } }).png().toFile(grey);
    await rejectsEmpty(commitOutput(grey, join(directory, "grey.png"), "media/grey.png", { media: "image" }));
    const textured = join(directory, "textured.tmp");
    await sharp({ create: { width: 256, height: 256, channels: 3, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toFile(textured);
    const saved = await commitOutput(textured, join(directory, "textured.png"), "media/textured.png", { media: "image" });
    assert.equal(saved.width, 256);
  });

  test("the verdict rule: dark mean, or flat and identical samples", () => {
    assert.equal(looksEmpty([{ avg: 3.9, min: 0, max: 60 }]), true);
    assert.equal(looksEmpty([{ avg: 40, min: 39, max: 42 }, { avg: 40.4, min: 39, max: 42 }]), true);
    assert.equal(looksEmpty([{ avg: 40, min: 39, max: 42 }, { avg: 90, min: 89, max: 92 }]), false, "a fade between flat frames is content");
    assert.equal(looksEmpty([{ avg: 20, min: 0, max: 255 }]), false);
  });
});

async function setupRouter(outputs: Uint8Array[], allowanceUsd: number) {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const recipe = ROUTER_RECIPES.find((entry) => entry.id === "router-nano-banana-2.1-edit")!;
  const calls: { key: string; body: Record<string, unknown> }[] = [];
  const models: RouterModelsPort = {
    async run(_model, body, options) {
      calls.push({ key: options!.idempotencyKey!, body });
      return { kind: "json", data: results.gemini_file, requestId: randomUUID(), servingProvider: null, droppedParams: null, replayed: false, creditsUsed: "12.5" } as RunResult;
    },
  };
  let served = 0;
  const cdn: MediaPorts = {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    get: async () => new Response(new Uint8Array(outputs[Math.min(served++, outputs.length - 1)])),
  };
  const router = new RouterExecutor({ jobs: context.store.jobs, models, mediaPorts: cdn, mediaRoot: context.store.dataDir, now });
  const mockExecutor = new MockExecutor({ jobs: context.store.jobs, now });
  const deps: RunDeps = {
    store: context.store,
    executors: { mock: mockExecutor, router, forRecipe: (entry) => (entry.kind === "router" ? router : mockExecutor) },
    allowanceUsd: () => allowanceUsd,
    now,
    // Lets the detached Router submission of the retry make progress between steps.
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  };
  const project = seedProject(context.store, now);
  const face = await importImage(
    context.store,
    { projectId: project.id, name: "face.png", bytes: await sharp({ create: { width: 64, height: 64, channels: 3, background: "#000", noise: { type: "gaussian", mean: 120, sigma: 30 } } }).png().toBuffer() },
    { now: now(), newId: randomUUID },
  );
  const request = {
    requestId: randomUUID(),
    projectId: project.id,
    recipe,
    input: { prompt: "Compose the references.", images: [face.relativePath], aspectRatio: "9:16" as const },
    inputs: [{ role: "image1", assetId: face.id, sha256: face.sha256 }],
  };
  return { ...context, deps, project, calls, request };
}

const blackStill = () => sharp({ create: { width: 768, height: 1376, channels: 3, background: "#000" } }).png().toBuffer();
const goodStill = () => sharp({ create: { width: 768, height: 1376, channels: 3, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer();

describe("automatic retry after a black output", () => {
  test("the first attempt returns black, one retry with a new seed succeeds, and both jobs carry a notice", async () => {
    const { deps, store, project, calls, request } = await setupRouter([await blackStill(), await goodStill()], 5);
    const started = await startGeneration(deps, request, { confirmUnquoted: true });
    assert.equal(started.kind, "started");
    if (started.kind !== "started") return;
    await started.settled;
    const done = await runToCompletion(deps, started.job.id);
    assert.equal(done.kind, "completed");
    if (done.kind !== "completed") return;

    const original = store.jobs.getRequired(started.job.id);
    assert.equal(original.status, "failed");
    assert.equal(original.status === "failed" && original.error.providerCode, "empty_output");
    assert.equal(original.notice, EMPTY_OUTPUT_NOTICE);
    assert.equal(original.creditsUsed, 12.5, "the spent credits stay on the failed job");

    assert.notEqual(done.job.id, original.id);
    assert.equal(done.job.requestId, retryRequestId(request.requestId));
    assert.equal(done.job.notice, retryNotice(original.id));
    assert.equal(done.assets.length, 1);
    assert.deepEqual(calls.map((call) => call.key), [original.id, done.job.id]);
    const seedOf = (body: Record<string, unknown>) => (body.generationConfig as { seed?: number }).seed;
    assert.equal(seedOf(calls[0].body), undefined);
    assert.equal(typeof seedOf(calls[1].body), "number");
    assert.equal(store.jobs.listByProject(project.id).length, 2);
  });

  test("a retry that is black again is final; there is never a second retry", async () => {
    const { deps, store, project, calls, request } = await setupRouter([await blackStill()], 5);
    const started = await startGeneration(deps, request, { confirmUnquoted: true });
    if (started.kind !== "started") return assert.fail(started.kind);
    await started.settled;
    const done = await runToCompletion(deps, started.job.id);
    assert.equal(done.kind, "failed");
    assert.equal(done.kind === "failed" && done.retry, undefined);
    assert.equal(done.job.requestId, retryRequestId(request.requestId));
    assert.equal(calls.length, 2);
    assert.equal(store.jobs.listByProject(project.id).length, 2);
    assert.equal(await runToCompletion(deps, done.job.id).then((step) => step.kind), "failed");
    assert.equal(store.jobs.listByProject(project.id).length, 2);
  });

  test("no retry when the allowance cannot cover it", async () => {
    const { deps, store, project, calls, request } = await setupRouter([await blackStill(), await goodStill()], 0.2);
    const started = await startGeneration(deps, request, { confirmUnquoted: true });
    if (started.kind !== "started") return assert.fail(started.kind);
    await started.settled;
    const done = await runToCompletion(deps, started.job.id);
    assert.equal(done.kind, "failed");
    assert.equal(done.job.id, started.job.id);
    assert.equal(done.kind === "failed" && done.retry, undefined);
    assert.equal(calls.length, 1);
    assert.equal(store.jobs.listByProject(project.id).length, 1);
  });
});
