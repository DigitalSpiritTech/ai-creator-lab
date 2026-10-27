/**
 * Workflow executor against a fake SDK client replaying recorded Cloud job states. No network, no credits.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { IdempotencyKeyReuse } from "@comfyorg/sdk";
import sharp from "sharp";
import type { Recipe } from "@/lib/catalog";
import { defaultRecipes } from "@/server/catalog/defaults";
import { MemoryJobStore, admitJob } from "./support/memory-job-store";
import { pollAndRetrieve } from "@/server/executors/run";
import type { GenerationInput, Job } from "@/server/executors/types";
import {
  planWorkflow,
  seedFromId,
  WorkflowExecutor,
  type CloudJobHandle,
  type WorkflowClient,
  type WorkflowHandle,
} from "@/server/executors/workflow";

const workflowsDir = fileURLToPath(new URL("../workflows", import.meta.url));
const jobs = JSON.parse(readFileSync(new URL("./fixtures/cloud/jobs.json", import.meta.url), "utf8"));
const run = promisify(execFile);

interface State {
  status: string;
  queuePosition?: number | null;
  error?: unknown;
  metrics?: Record<string, number>;
}

/** Replays recorded job states; outputs are local files copied on download. */
class FakeCloud implements WorkflowClient {
  submitted: { graph: Record<string, unknown>; key: string }[] = [];
  uploads: { path: string; width: number; height: number }[] = [];
  gets = 0;
  private index = 0;
  submitError: (() => unknown) | undefined;


  constructor(
    private readonly jobId: string,
    private readonly states: State[],
    private readonly outputNode: string,
    private readonly outputFiles: { source: string; type: string; contentType: string }[],
  ) {}

  workflows = {
    fromJson: (graph: Record<string, unknown>): WorkflowHandle => ({
      json: graph,
      setInput(nodeId: string, field: string, value: unknown) {
        (graph[nodeId] as { inputs: Record<string, unknown> }).inputs[field] = value;
      },
    }),
  };

  assets = {
    fromFile: (path: string) => {
      const pending = sharp(path).metadata();
      const record = { path, width: 0, height: 0 };
      this.uploads.push(record);
      this.pendingUploads.push(pending.then((info) => Object.assign(record, { width: info.width, height: info.height })));
      return { asset: path };
    },
  };

  pendingUploads: Promise<unknown>[] = [];

  async submit(workflow: WorkflowHandle, options: { idempotencyKey: string }): Promise<CloudJobHandle> {
    await Promise.all(this.pendingUploads);
    this.submitted.push({ graph: structuredClone(workflow.json), key: options.idempotencyKey });
    const error = await this.submitError?.();
    if (error) throw error;
    return this.handle({ status: "queued", queuePosition: 2 });
  }

  jobs = {
    get: async (id: string): Promise<CloudJobHandle> => {
      assert.equal(id, this.jobId);
      this.gets++;
      const state = this.states[Math.min(this.index, this.states.length - 1)];
      this.index++;
      return this.handle(state);
    },
  };

  private handle(state: State): CloudJobHandle {
    const done = state.status === "succeeded";
    return {
      id: this.jobId,
      status: state.status,
      error: state.error ?? null,
      queuePosition: state.queuePosition ?? null,
      metrics: state.metrics,
      getOutputs: (nodeId: string) =>
        done && nodeId === this.outputNode
          ? this.outputFiles.map((file) => ({
              type: file.type,
              contentType: file.contentType,
              toFile: async (path: string) => {
                await copyFile(file.source, path);
                return path;
              },
            }))
          : [],
      cancel: async () => undefined,
    };
  }
}

async function recipe(id: string): Promise<Recipe> {
  const found = (await defaultRecipes(workflowsDir)).find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
}

function request(jobs: MemoryJobStore, recipeValue: Recipe, input: Partial<GenerationInput> & { prompt: string }): Job {
  return admitJob(jobs, { recipe: recipeValue, input });
}

async function png(path: string, width: number, height: number): Promise<string> {
  await sharp({ create: { width, height, channels: 3, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toFile(path);
  return path;
}

async function withTemp<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "acl-workflow-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("text to image runs queued to succeeded, binds slots, and stores a verified PNG", () =>
  withTemp(async (directory) => {
    const output = await png(join(directory, "out.png"), 1024, 1024);
    const fake = new FakeCloud(jobs.succeeded.id, jobs.succeeded.states, "9", [{ source: output, type: "image", contentType: "image/png" }]);
    const repository = new MemoryJobStore();
    const executor = new WorkflowExecutor({ jobs: repository, client: fake, workflowsDir });
    const zImage = await recipe("z-image-turbo-t2i");
    const submitted = await executor.submit(request(repository, zImage, { prompt: "Product photograph of a green bottle", images: [], aspectRatio: "1:1", seed: 11 }));
    assert.equal(submitted.kind, "accepted");
    const job = submitted.job!;
    assert.equal(job.status, "queued");
    assert.equal(job.providerRef, jobs.succeeded.id);
    assert.equal(fake.submitted[0].key, job.id);
    const graph = fake.submitted[0].graph as Record<string, { inputs: Record<string, unknown> }>;
    assert.equal(graph["4"].inputs.text, "Product photograph of a green bottle");
    assert.equal(graph["6"].inputs.width, 1024);
    assert.equal(graph["6"].inputs.height, 1024);
    assert.equal(graph["8"].inputs.seed, 11);

    const first = await executor.poll(job.id);
    assert.equal(first.kind, "pending");
    assert.equal(first.kind === "pending" && first.queuePosition, 1);
    assert.equal((await executor.poll(job.id)).kind, "pending");
    assert.equal((await executor.poll(job.id)).kind, "ready");
    const retrieved = await executor.retrieve(job.id, { root: directory, folder: "media" });
    assert.equal(retrieved.kind, "completed");
    if (retrieved.kind !== "completed") return;
    assert.deepEqual(retrieved.metrics, { queue_ms: 8400, execution_ms: 7700 });
    const [saved] = retrieved.job.retrieved;
    assert.equal(saved.relativePath, `media/${job.id}-0.png`);
    assert.equal(saved.width, 1024);
    assert.equal(saved.mime, "image/png");
    const bytes = await readFile(join(directory, saved.relativePath));
    assert.deepEqual(bytes, await readFile(output));
    assert.deepEqual((await readdir(join(directory, "media"))).filter((name) => name.endsWith(".tmp")), []);

    const again = await executor.submit(admitJob(repository, { recipe: zImage, input: { prompt: "Product photograph of a green bottle", aspectRatio: "1:1", seed: 11 }, requestId: job.requestId }));
    assert.equal(again.kind, "existing");
    assert.equal(fake.submitted.length, 1);
  }));

test("a failed Cloud job is recorded with the node and reason", () =>
  withTemp(async () => {
    const fake = new FakeCloud(jobs.failed.id, jobs.failed.states, "9", []);
    const repository = new MemoryJobStore();
    const executor = new WorkflowExecutor({ jobs: repository, client: fake, workflowsDir });
    const zImage = await recipe("z-image-turbo-t2i");
    const submitted = await executor.submit(request(repository, zImage, { prompt: "A still", images: [] }));
    assert.equal(submitted.kind, "accepted");
    const polled = await executor.poll(submitted.job!.id);
    assert.equal(polled.kind, "failed");
    if (polled.kind !== "failed") return;
    assert.match(polled.error.message, /ImageScaleToTotalPixels \(node 30\)/);
    assert.equal(polled.error.providerCode, "node_execution_error");
    assert.equal(polled.job.status, "failed");
  }));

test("an ambiguous submit becomes uncertain and is resolved with the same key", () =>
  withTemp(async (directory) => {
    const output = await png(join(directory, "out.png"), 1024, 1024);
    const fake = new FakeCloud(jobs.succeeded.id, jobs.succeeded.states, "9", [{ source: output, type: "image", contentType: "image/png" }]);
    let clock = 1_000_000;
    const repository = new MemoryJobStore();
    const executor = new WorkflowExecutor({ jobs: repository, client: fake, workflowsDir, now: () => clock });
    fake.submitError = () => (fake.submitted.length === 1 ? new TypeError("fetch failed") : undefined);
    const submitted = await executor.submit(request(repository, await recipe("z-image-turbo-t2i"), { prompt: "A still", images: [] }));
    assert.equal(submitted.kind, "uncertain");
    const job = submitted.job!;
    assert.equal(job.providerRef, null);
    assert.match(job.notice!, /same idempotency key/);
    clock += 60_000;
    const recovered = await executor.poll(job.id);
    assert.equal(recovered.kind, "pending");
    assert.equal(fake.submitted.length, 2);
    assert.deepEqual(fake.submitted.map((entry) => entry.key), [job.id, job.id]);
    assert.deepEqual(fake.submitted[0].graph, fake.submitted[1].graph);
    assert.equal(repository.get(job.id)?.providerRef, jobs.succeeded.id);
  }));

test("IdempotencyKeyReuse recovers by the saved job id, and never resubmits without one", () =>
  withTemp(async () => {
    const repository = new MemoryJobStore();
    let clock = 5_000_000;
    const fake = new FakeCloud(jobs.succeeded.id, jobs.succeeded.states, "9", []);
    const executor = new WorkflowExecutor({ jobs: repository, client: fake, workflowsDir, now: () => clock });
    const zImage = await recipe("z-image-turbo-t2i");

    fake.submitError = () => new TypeError("socket hang up");
    const first = await executor.submit(request(repository, zImage, { prompt: "A still", images: [] }));
    assert.equal(first.kind, "uncertain");
    const job = first.job!;
    // Another worker saved the provider id; this worker's resend meets the reused key.
    fake.submitError = async () => {
      const current = repository.get(job.id);
      assert.ok(current);
      repository.put({ ...current, providerRef: jobs.succeeded.id, revision: current.revision + 1 });
      return new IdempotencyKeyReuse("Idempotency key reused", { code: "idempotency_key_reuse", httpStatus: 422 });
    };
    clock += 300_000;
    const recovered = await executor.poll(job.id);
    assert.equal(recovered.kind, "pending");
    assert.equal(recovered.job.providerRef, jobs.succeeded.id);
    assert.equal(recovered.job.status, "queued");

    fake.submitError = undefined;
    const lost = await executor.submit(request(repository, zImage, { prompt: "Another still", images: [] }));
    fake.submitError = () => new IdempotencyKeyReuse("Idempotency key reused", { code: "idempotency_key_reuse", httpStatus: 422 });
    assert.equal(lost.kind, "accepted");
    const orphan = repository.add({ ...lost.job!, id: randomUUID(), requestId: randomUUID(), status: "uncertain", providerRef: null, revision: 0 } as Job);
    clock += 300_000;
    const before = fake.submitted.length;
    const stuck = await executor.poll(orphan.job.id);
    assert.equal(stuck.kind, "uncertain");
    assert.match(stuck.job.notice!, /will not be sent again/);
    assert.equal(fake.submitted.length, before + 1);
    assert.equal(fake.submitted.at(-1)!.key, orphan.job.id);
  }));

test("output verification failure fails the job and leaves no file behind", () =>
  withTemp(async (directory) => {
    const wrong = await png(join(directory, "wrong.png"), 512, 512);
    const fake = new FakeCloud(jobs.succeeded.id, [{ status: "succeeded" }], "9", [{ source: wrong, type: "image", contentType: "image/png" }]);
    const repository = new MemoryJobStore();
    const executor = new WorkflowExecutor({ jobs: repository, client: fake, workflowsDir });
    const submitted = await executor.submit(request(repository, await recipe("z-image-turbo-t2i"), { prompt: "A still", images: [], width: 1024, height: 1024 }));
    assert.equal((await executor.poll(submitted.job!.id)).kind, "ready");
    const retrieved = await executor.retrieve(submitted.job!.id, { root: directory, folder: "media" });
    assert.equal(retrieved.kind, "failed");
    if (retrieved.kind !== "failed") return;
    assert.match(retrieved.error.message, /512x512; 1024x1024 was requested/);
    assert.deepEqual(await readdir(join(directory, "media")), []);
  }));

test("LTX fits the start frame to 576x1024, binds length on both nodes, and verifies the MP4", () =>
  withTemp(async (directory) => {
    const start = await png(join(directory, "start.png"), 1000, 800);
    const clip = join(directory, "clip.mp4");
    await run(process.env.FFMPEG_PATH || "ffmpeg", [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=576x1024:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-frames:v", "121", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", clip,
    ]);
    const fake = new FakeCloud(jobs.ltx.id, jobs.ltx.states, "9", [{ source: clip, type: "video", contentType: "video/mp4" }]);
    const repository = new MemoryJobStore();
    const executor = new WorkflowExecutor({ jobs: repository, client: fake, workflowsDir });
    const submitted = await executor.submit(request(repository, await recipe("ltx-2.5-i2v"), { prompt: "She says hello", images: [start], durationSeconds: 5 }));
    assert.equal(submitted.kind, "accepted");
    assert.deepEqual(fake.uploads.map(({ width, height }) => [width, height]), [[576, 1024]]);
    const graph = fake.submitted[0].graph as Record<string, { inputs: Record<string, unknown> }>;
    assert.equal(graph["8"].inputs.length, 121);
    assert.equal(graph["10"].inputs.frames_number, 121);
    assert.equal(graph["12"].inputs.noise_seed, seedFromId(submitted.job!.id));
    assert.ok(graph["22"].inputs.image && typeof graph["22"].inputs.image === "object");
    const outcome = await pollAndRetrieve(executor, submitted.job!.id, { root: directory, folder: "clips" }, { sleep: async () => undefined });
    assert.equal(outcome.kind, "completed");
    const [saved] = (outcome as { job: Job }).job.retrieved;
    assert.equal(saved.mime, "video/mp4");
    assert.equal(saved.video?.frames, 121);
    assert.equal(saved.video?.fps, 24);
    assert.equal(saved.video?.hasAudio, true);
  }));

test("planWorkflow rejects wrong reference counts, unsupported sizes, and broken lengths", async () => {
  const edit = await recipe("qwen-image-edit-2511-2ref");
  const ltx = await recipe("ltx-2.5-i2v");
  const graph = JSON.parse(await readFile(join(workflowsDir, "qwen-image-edit-2511-2ref.api.json"), "utf8"));
  const ltxGraph = JSON.parse(await readFile(join(workflowsDir, "ltx-2.5-i2v.api.json"), "utf8"));
  assert.ok(edit.kind === "workflow" && ltx.kind === "workflow");
  assert.throws(() => planWorkflow(edit, { prompt: "Compose", images: ["a.png"] }, graph, 1), /takes 2 reference images; 1 given/);
  assert.throws(() => planWorkflow(edit, { prompt: "Compose", images: ["a.png", "b.png"], width: 770, height: 1344 }, graph, 1), /not a size/);
  assert.throws(() => planWorkflow(ltx, { prompt: "Move", images: ["a.png"], length: 120 }, ltxGraph, 1), /8n\+1/);
  const plan = planWorkflow(edit, { prompt: "Compose", images: ["a.png", "b.png"] }, graph, 9);
  assert.deepEqual(plan.images, [{ slot: "image1", path: "a.png" }, { slot: "image2", path: "b.png" }]);
  assert.equal(plan.values.width, 768);
  assert.equal(plan.values.seed, 9);
});

test("LTX first-and-last fits both frames to one canvas, binds each to its loader, and verifies the MP4", () =>
  withTemp(async (directory) => {
    const first = await png(join(directory, "start.png"), 1000, 800);
    const last = await png(join(directory, "end.png"), 700, 1200);
    const clip = join(directory, "clip.mp4");
    await run(process.env.FFMPEG_PATH || "ffmpeg", [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=576x1024:r=24", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
      "-frames:v", "121", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", clip,
    ]);
    const fake = new FakeCloud(jobs.ltx.id, jobs.ltx.states, "9", [{ source: clip, type: "video", contentType: "video/mp4" }]);
    const repository = new MemoryJobStore();
    const executor = new WorkflowExecutor({ jobs: repository, client: fake, workflowsDir });
    const job = request(repository, await recipe("ltx-2.5-flf2v"), {
      prompt: "She sets the bottle down and looks out the window.",
      images: [first, last],
      durationSeconds: 5,
      slots: { firstStrength: 0.8, lastStrength: 0.6 },
    });
    const submitted = await executor.submit(job);
    assert.equal(submitted.kind, "accepted");
    assert.deepEqual(fake.uploads.map(({ width, height }) => [width, height]), [[576, 1024], [576, 1024]]);
    const graph = fake.submitted[0].graph as Record<string, { inputs: Record<string, unknown> }>;
    const loaded = (node: string) => (graph[node].inputs.image as { asset: string }).asset;
    assert.match(loaded("22"), /first\.png$/);
    assert.match(loaded("25"), /last\.png$/);
    assert.deepEqual([graph["8"].inputs.length, graph["10"].inputs.frames_number], [121, 121]);
    assert.deepEqual([graph["24"].inputs.strength, graph["27"].inputs.strength], [0.8, 0.6]);
    assert.equal(graph["12"].inputs.noise_seed, seedFromId(submitted.job!.id));
    const outcome = await pollAndRetrieve(executor, submitted.job!.id, { root: directory, folder: "clips" }, { sleep: async () => undefined });
    assert.equal(outcome.kind, "completed");
    const [saved] = (outcome as { job: Job }).job.retrieved;
    assert.deepEqual([saved.mime, saved.width, saved.height, saved.video?.frames], ["video/mp4", 576, 1024, 121]);
  }));
