/**
 * QA regressions: a pending Router call is never sent twice, unfinished jobs resume on startup, and
 * the allowance ledger settles local failures and expired uncertain jobs at zero.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { afterEach, describe, test } from "node:test";
import { type RunResult } from "@comfyorg/sdk";
import sharp from "sharp";
import type { Recipe } from "@/lib/catalog";
import { type Job, advanceJob, createJob } from "@/lib/domain/job";
import { MOCK_RECIPES, ROUTER_RECIPES } from "@/server/catalog/defaults";
import { MockExecutor, RouterExecutor } from "@/server/executors";
import type { RouterModelsPort } from "@/server/executors/router";
import {
  COLLECTION_WINDOW_MS,
  type RunDeps,
  UNCERTAIN_EXPIRED_NOTICE,
  advanceGeneration,
  allowanceState,
  chargedUsd,
  recoverAndDrain,
  startGeneration,
} from "@/server/executors/run";
import { startRecoveryOnce } from "@/server/tools/recovery";
import { MemoryJobStore, TEST_PROJECT_ID, admitJob } from "./support/memory-job-store";
import { clock, seedProject, tempStore } from "./support/domain-fixtures";

const results = JSON.parse(readFileSync(new URL("./fixtures/router/results.json", import.meta.url), "utf8"));
const LTX = ROUTER_RECIPES.find((recipe) => recipe.id === "router-ltx-2.5-fast")!;
const MOCK_STILL: Recipe = MOCK_RECIPES[0];

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A Router port whose answer the test releases by hand. */
function heldModels() {
  const calls: string[] = [];
  let release: (result: RunResult) => void = () => undefined;
  const models: RouterModelsPort = {
    run(_model, _body, options) {
      calls.push(options!.idempotencyKey!);
      return new Promise<RunResult>((resolve) => {
        release = resolve;
      });
    },
  };
  return { models, calls, release: () => release({ kind: "json", data: results.ltx, requestId: "req-1", servingProvider: null, droppedParams: null, replayed: false, creditsUsed: "40" } as RunResult) };
}

describe("Router calls in flight", () => {
  test("a poll after the stale window does not resend a pending call, and the job is refreshed while it waits", async () => {
    const jobs = new MemoryJobStore();
    let now = 1_000_000;
    const held = heldModels();
    const router = new RouterExecutor({ jobs, models: held.models, now: () => now, heartbeatMs: 5 });
    const job = admitJob(jobs, { recipe: LTX, input: { prompt: "A bottle on a counter." } }, now);
    const settled = router.submit(job);
    await wait(1);
    assert.equal(router.isInFlight(job.id), true);
    now += 3 * 60_000;
    const polled = await router.poll(job.id);
    assert.equal(polled.kind, "pending");
    assert.deepEqual(held.calls, [job.id]);
    await wait(30);
    const refreshed = jobs.get(job.id)!;
    assert.equal(refreshed.status, "submitting");
    assert.match(refreshed.notice ?? "", /never sent twice/);
    assert.equal(refreshed.updatedAt, now);
    held.release();
    assert.equal((await settled).kind, "accepted");
    assert.equal(router.isInFlight(job.id), false);
    assert.equal((await router.poll(job.id)).kind, "ready");
    assert.deepEqual(held.calls, [job.id]);
  });

  test("advanceGeneration leaves an in-flight Router job alone", async () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    let now = 2_000_000;
    const held = heldModels();
    const router = new RouterExecutor({ jobs: store.jobs, models: held.models, now: () => now, heartbeatMs: 60_000 });
    const mock = new MockExecutor({ jobs: store.jobs });
    const deps: RunDeps = {
      store,
      executors: { mock, router, forRecipe: (recipe) => (recipe.kind === "router" ? router : mock) },
      allowanceUsd: () => 5,
      now: () => now,
    };
    const project = seedProject(store, () => now);
    const started = await startGeneration(deps, { requestId: randomUUID(), projectId: project.id, recipe: LTX, input: { prompt: "A bottle on a counter.", images: [] } }, { confirmUnquoted: true });
    assert.equal(started.kind, "started");
    now += 10 * 60_000;
    const step = await advanceGeneration(deps, started.kind === "started" ? started.job.id : "");
    assert.equal(step.kind, "waiting");
    assert.equal(held.calls.length, 1);
    held.release();
    if (started.kind === "started") await started.settled;
  });
});

describe("restart recovery", () => {
  test("a job left queued is advanced to completion on startup, with one log line", async () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    const left = store.jobs.add(
      createJob({ id: randomUUID(), requestId: randomUUID(), projectId: project.id, request: { recipe: MOCK_STILL, input: { prompt: "Avery" } } }, now()),
    ).job;
    const lines: string[] = [];
    const first = startRecoveryOnce(store, (line) => lines.push(line));
    assert.equal(startRecoveryOnce(store), first, "recovery starts once per store");
    const outcomes = await first;
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].kind, "completed");
    assert.equal(store.jobs.getRequired(left.id).status, "completed");
    assert.deepEqual(lines, [`[recovery] job ${left.id} (${MOCK_STILL.id}): completed, 1 output(s)`]);
    assert.doesNotMatch(lines[0], /Avery|\//);
  });
});

describe("allowance settlement", () => {
  const base = (overrides: Partial<Job> = {}): Job =>
    ({ ...createJob({ id: randomUUID(), requestId: randomUUID(), projectId: TEST_PROJECT_ID, request: { recipe: LTX, input: { prompt: "x" } }, reservedUsd: 1 }, 0), ...overrides }) as Job;
  const failed = (code: "invalid" | "provider" | "budget", providerRef: string | null) =>
    advanceJob(base({ providerRef }), { status: "failed", error: { code, message: "No.", retryable: false } }, 10);

  test("a failure before anything reached the provider costs nothing; provider failures keep the reservation", () => {
    assert.deepEqual(chargedUsd(failed("invalid", null), 10), { spentUsd: 0, reservedUsd: 0 });
    assert.deepEqual(chargedUsd(failed("budget", null), 10), { spentUsd: 0, reservedUsd: 0 });
    assert.deepEqual(chargedUsd(failed("provider", null), 10), { spentUsd: 1, reservedUsd: 0 });
    assert.deepEqual(chargedUsd(failed("invalid", "req-1"), 10), { spentUsd: 1, reservedUsd: 0 });
    assert.deepEqual(chargedUsd({ ...failed("provider", "req-1"), creditsUsed: 21 }, 10), { spentUsd: 0.1, reservedUsd: 0 });
  });

  test("uncertain jobs hold their reservation for 23 hours, then settle at zero with a notice", async () => {
    const uncertain = advanceJob(advanceJob(base(), { status: "submitting" }, 1), { status: "uncertain" }, 2);
    assert.deepEqual(chargedUsd(uncertain, COLLECTION_WINDOW_MS), { spentUsd: 0, reservedUsd: 1 });
    assert.deepEqual(chargedUsd(uncertain, COLLECTION_WINDOW_MS + 1), { spentUsd: 0, reservedUsd: 0 });

    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    let now = 1_000;
    const project = seedProject(store, () => now);
    const sent: string[] = [];
    const router = new RouterExecutor({ jobs: store.jobs, models: { run: async (_m, _b, o) => (sent.push(o!.idempotencyKey!), Promise.reject(new TypeError("fetch failed"))) }, now: () => now });
    const mock = new MockExecutor({ jobs: store.jobs });
    const deps: RunDeps = { store, executors: { mock, router, forRecipe: (recipe) => (recipe.kind === "router" ? router : mock) }, allowanceUsd: () => 5, now: () => now };
    const started = await startGeneration(deps, { requestId: randomUUID(), projectId: project.id, recipe: LTX, input: { prompt: "x", images: [] } }, { confirmUnquoted: true });
    assert.equal(started.kind === "started" && (await started.settled).kind, "uncertain");
    assert.equal(allowanceState(deps).reservedUsd, 1);
    now += COLLECTION_WINDOW_MS + 1;
    assert.deepEqual(allowanceState(deps), { allowanceUsd: 5, spentUsd: 0, reservedUsd: 0 });
    const step = await advanceGeneration(deps, started.kind === "started" ? started.job.id : "");
    assert.equal(step.kind, "waiting");
    assert.equal(step.job.notice, UNCERTAIN_EXPIRED_NOTICE);
    assert.equal(sent.length, 1, "an expired uncertain job is never sent again");
    assert.equal((await recoverAndDrain(deps)).length, 1);
    assert.equal(sent.length, 1);
  });

  test("a local workflow failure at submit does not count against the allowance", async () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
    assert.ok(png.length > 0);
    const job = store.jobs.add(
      createJob({ id: randomUUID(), requestId: randomUUID(), projectId: project.id, request: { recipe: LTX, input: { prompt: "x" } }, reservedUsd: 1 }, now()),
    ).job;
    const failed = advanceJob(job, { status: "failed", error: { code: "invalid", message: "A reference image file is missing.", retryable: false } }, now());
    assert.equal(store.jobs.transition(job, failed), true);
    const mock = new MockExecutor({ jobs: store.jobs });
    assert.deepEqual(allowanceState({ store, executors: { mock, forRecipe: () => mock }, allowanceUsd: () => 5 }), { allowanceUsd: 5, spentUsd: 0, reservedUsd: 0 });
  });
});
