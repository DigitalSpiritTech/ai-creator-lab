/**
 * Executor contract against the mock executor and the in-memory repository: idempotent requests,
 * guarded transitions, labeled outputs, simulated failures, cancel, and the allowance gate.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Recipe } from "@/lib/catalog";
import { MOCK_RECIPES } from "@/server/catalog/defaults";
import { checkAllowance, creditsToUsd, readAllowanceUsd, readCreditBalance, quoteRouter } from "@/server/executors/allowance";
import { jobError, transition } from "@/server/executors/jobs";
import { MockExecutor, mockDimensions } from "@/server/executors/mock";
import { pollAndRetrieve } from "@/server/executors/run";
import { JobSchema, type Job } from "@/server/executors/types";
import { MemoryJobStore, admitJob } from "./support/memory-job-store";

function mockRecipe(capability: Recipe["capability"]): Recipe {
  const recipe = MOCK_RECIPES.find((entry) => entry.capability === capability);
  assert.ok(recipe);
  return recipe;
}

function admit(jobs: MemoryJobStore, capability: Recipe["capability"], prompt = "Avery holds the Ridgeline bottle <by the window>"): Job {
  return admitJob(jobs, { recipe: mockRecipe(capability), input: { prompt, aspectRatio: "9:16" } });
}

async function withTemp<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "acl-contract-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("submit, poll, retrieve produce a labeled still with a verified hash", () =>
  withTemp(async (root) => {
    const jobs = new MemoryJobStore();
    const executor = new MockExecutor({ jobs });
    assert.equal((await executor.estimate()).kind, "free");
    const submitted = await executor.submit(admit(jobs, "text_to_image", "Avery & the <bottle>"));
    assert.equal(submitted.kind, "accepted");
    const job = submitted.job!;
    assert.equal(job.status, "submitting");
    assert.equal((await executor.retrieve(job.id, { root, folder: "media" })).kind, "not_ready");
    assert.equal((await executor.poll(job.id)).kind, "ready");
    const retrieved = await executor.retrieve(job.id, { root, folder: "media" });
    assert.equal(retrieved.kind, "completed");
    const saved = jobs.get(job.id)!;
    JobSchema.parse(saved);
    assert.equal(saved.status, "retrieving", "retrieve records files; only the commit completes a job");
    assert.equal(saved.creditsUsed, 0);
    const [output] = saved.retrieved;
    assert.equal(output.mime, "image/svg+xml");
    assert.deepEqual([output.width, output.height], [720, 1280]);
    const svg = await readFile(join(root, output.relativePath));
    assert.equal(createHash("sha256").update(svg).digest("hex"), output.sha256);
    const text = svg.toString("utf8");
    assert.match(text, /MOCK \/ NO AI/);
    assert.match(text, /STILL FRAME/);
    assert.match(text, /Avery &amp; the &lt;bottle&gt;/);
    assert.doesNotMatch(text, /<bottle>/);
    assert.equal((await executor.poll(job.id)).kind, "ready");
    const again = await executor.retrieve(job.id, { root, folder: "media" });
    assert.equal(again.kind === "completed" && again.job.retrieved[0].sha256, output.sha256);
  }));

test("video capabilities produce a static storyboard plate, and the runner completes it", () =>
  withTemp(async (root) => {
    const jobs = new MemoryJobStore();
    const executor = new MockExecutor({ jobs });
    const submitted = await executor.submit(admit(jobs, "image_to_video"));
    const outcome = await pollAndRetrieve(executor, submitted.job!.id, { root, folder: "clips" }, { sleep: async () => undefined });
    assert.equal(outcome.kind, "completed");
    const [output] = jobs.get(submitted.job!.id)!.retrieved;
    const text = await readFile(join(root, output.relativePath), "utf8");
    assert.match(text, /VIDEO STORYBOARD/);
    assert.match(text, /02 \/ HOLD/);
  }));

test("a repeated requestId admits one job, and a second submit of it sends nothing", async () => {
  const jobs = new MemoryJobStore();
  const executor = new MockExecutor({ jobs });
  const first = admit(jobs, "text_to_image");
  const again = admitJob(jobs, { recipe: mockRecipe("text_to_image"), input: { prompt: "Something else" }, requestId: first.requestId });
  assert.equal(again.id, first.id);
  assert.equal((await executor.submit(first)).kind, "accepted");
  const repeated = await executor.submit(first);
  assert.equal(repeated.kind, "existing");
  assert.equal(repeated.job!.id, first.id);
  assert.equal(jobs.all().length, 1);
});

test("simulated failures surface at the stage they were asked for", () =>
  withTemp(async (root) => {
    for (const stage of ["submit", "poll", "retrieve"] as const) {
      const jobs = new MemoryJobStore();
      const executor = new MockExecutor({ jobs, failure: (input) => (input.prompt.includes("fail") ? { stage, reason: `Simulated ${stage} failure.` } : undefined) });
      const submitted = await executor.submit(admit(jobs, "text_to_image", "please fail"));
      const job = submitted.job!;
      if (stage === "submit") {
        assert.equal(submitted.kind, "failed");
      } else {
        const polled = await executor.poll(job.id);
        if (stage === "poll") assert.equal(polled.kind, "failed");
        else assert.equal((await executor.retrieve(job.id, { root, folder: "media" })).kind, "failed");
      }
      const saved = jobs.get(job.id)!;
      assert.equal(saved.status, "failed");
      assert.equal(saved.status === "failed" && saved.error.message, `Simulated ${stage} failure.`);
    }
  }));

test("cancel fails an unfinished job and leaves finished ones alone", () =>
  withTemp(async (root) => {
    const jobs = new MemoryJobStore();
    const executor = new MockExecutor({ jobs });
    const open = await executor.submit(admit(jobs, "text_to_image"));
    const canceled = await executor.cancel(open.job!.id);
    assert.equal(canceled.kind, "canceled");
    assert.equal(canceled.kind === "canceled" && canceled.job.status === "failed" && canceled.job.error.providerCode, "canceled");
    const done = await executor.submit(admit(jobs, "text_to_image"));
    await pollAndRetrieve(executor, done.job!.id, { root, folder: "media" }, { sleep: async () => undefined });
    assert.equal((await executor.cancel(done.job!.id)).kind, "too_late");
  }));

test("transitions are guarded and use optimistic revisions", () => {
  const jobs = new MemoryJobStore();
  const job = admit(jobs, "text_to_image");
  const submitting = transition(jobs, job, { status: "submitting", providerRef: "remote-1" }, 2);
  assert.equal(submitting.revision, 1);
  assert.throws(() => transition(jobs, job, { status: "running" }, 3), /updated this job first/);
  const failed = transition(jobs, submitting, { status: "failed", error: jobError("provider", "Rejected") }, 4);
  assert.throws(() => transition(jobs, failed, { status: "queued" }, 5), /cannot become queued/);
  assert.equal(jobs.all().length, 1);
});

test("mock sizes follow explicit size first, then aspect ratio", () => {
  assert.deepEqual(mockDimensions({ prompt: "x", images: [], width: 640, height: 480 }), { width: 640, height: 480 });
  assert.deepEqual(mockDimensions({ prompt: "x", images: [], aspectRatio: "16:9" }), { width: 1280, height: 720 });
  assert.deepEqual(mockDimensions({ prompt: "x", images: [], aspectRatio: "4:5" }), { width: 928, height: 1152 });
});

test("the allowance gate blocks every paid path at zero and reserves otherwise", () => {
  const recipe = { title: "Example", ceilingUsd: 0.15 };
  const quoted = { kind: "quoted" as const, usd: 0.06, credits: 12.6, source: "live" as const, note: "" };
  const unquoted = { kind: "unquoted" as const, ceilingUsd: null, note: "No live price." };
  assert.equal(readAllowanceUsd({}), 0);
  assert.equal(readAllowanceUsd({ GENERATION_ALLOWANCE_USD: "-1" }), 0);
  assert.equal(readAllowanceUsd({ GENERATION_ALLOWANCE_USD: "5" }), 5);
  const zero = { allowanceUsd: 0, spentUsd: 0, reservedUsd: 0 };
  assert.equal(checkAllowance(zero, quoted, recipe).kind, "blocked");
  assert.equal(checkAllowance(zero, unquoted, recipe).kind, "blocked");
  assert.equal(checkAllowance(zero, { kind: "free", note: "" }, recipe).kind, "allowed");
  const five = { allowanceUsd: 5, spentUsd: 1, reservedUsd: 0.5 };
  assert.deepEqual(checkAllowance(five, quoted, recipe), { kind: "allowed", reserveUsd: 0.06, remainingUsd: 3.44 });
  const confirm = checkAllowance(five, unquoted, recipe);
  assert.equal(confirm.kind, "confirm");
  assert.equal(confirm.kind === "confirm" && confirm.reserveUsd, 0.15);
  assert.equal(checkAllowance({ allowanceUsd: 5, spentUsd: 4.95, reservedUsd: 0 }, quoted, recipe).kind, "blocked");
  assert.equal(checkAllowance(five, unquoted, { title: "No ceiling" }).kind, "blocked");
  assert.equal(creditsToUsd(210), 1);
});

test("credit balance and Router quotes are read with injected fetch", async () => {
  const seen: string[] = [];
  const fetchBalance = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(String(url));
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "fixture-key");
    return Response.json({ effective_balance_cents: 2604.77 });
  }) as typeof fetch;
  assert.deepEqual(await readCreditBalance("fixture-key", fetchBalance), { cents: 2604.77, credits: 5496 });
  assert.deepEqual(seen, ["https://cloud.comfy.org/api/billing/balance"]);
  const respond = (status: number, body: unknown) => (async () => (status === 200 ? Response.json(body) : new Response("no", { status }))) as unknown as typeof fetch;
  const exact = await quoteRouter("k", "bfl/flux-2-pro", { prompt: "x" }, respond(200, { source: "exact", amount: "0.06", currency: "USD", model: "bfl/flux-2-pro" }));
  assert.deepEqual([exact.kind, exact.kind === "quoted" && exact.usd], ["quoted", 0.06]);
  const range = await quoteRouter("k", "bfl/flux-2-pro", {}, respond(200, { source: "estimated", min_amount: "0.1", max_amount: "0.3", currency: "USD" }));
  assert.equal(range.kind === "quoted" && range.usd, 0.3);
  assert.equal((await quoteRouter("k", "bfl/flux-2-pro", {}, respond(403, {}))).kind, "unquoted");
  assert.equal((await quoteRouter("k", "bfl/flux-2-pro", {}, respond(200, { source: "unknown", reason: "unpriced_model" }))).kind, "unquoted");
  assert.equal((await quoteRouter("k", "bfl/flux-2-pro", {}, respond(402, {}))).kind, "rejected");
});
