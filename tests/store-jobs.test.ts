import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { toFailure } from "@/lib/domain/failure";
import { advanceJob, createJob } from "@/lib/domain/job";
import { createScript, reviseScript } from "@/lib/domain/script";
import { openStore } from "@/server/store";
import { clock, ridgelineBeats, seedProject, tempStore } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function newJob(projectId: string, now: number, requestId = randomUUID(), prompt = "Avery portrait") {
  return createJob(
    {
      id: randomUUID(),
      requestId,
      projectId,
      recipeId: "mock-still",
      capability: "text_to_image",
      executor: "mock",
      request: { prompt, inputs: [], target: { kind: "loose" } },
    },
    now,
  );
}

describe("jobs", () => {
  test("admission is idempotent by request id; reusing it for a different request conflicts", () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    const requestId = randomUUID();
    const first = store.jobs.add(newJob(project.id, now(), requestId));
    assert.equal(first.created, true);
    const retry = store.jobs.add({ ...newJob(project.id, now(), requestId), id: randomUUID() });
    assert.equal(retry.created, false);
    assert.equal(retry.job.id, first.job.id);
    assert.throws(() => store.jobs.add(newJob(project.id, now(), requestId, "Different")), (e) => toFailure(e).code === "conflict");
  });

  test("transitions are optimistic and terminal states are final", () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    const queued = store.jobs.add(newJob(project.id, now())).job;
    const submitting = advanceJob(queued, { status: "submitting" }, now());
    assert.equal(store.jobs.transition(queued, submitting), true);
    assert.equal(store.jobs.transition(queued, advanceJob(queued, { status: "failed", error: { code: "provider", message: "x", retryable: false } }, now())), false);
    const failed = advanceJob(submitting, { status: "failed", error: { code: "provider", message: "Rejected", retryable: false } }, now());
    assert.equal(store.jobs.transition(submitting, failed), true);
    assert.equal(store.jobs.getRequired(queued.id).status, "failed");
    assert.equal(store.jobs.transition(failed, { ...failed, revision: failed.revision + 1 }), false);
    assert.equal(store.database.prepare("SELECT status FROM jobs WHERE id = ?").get(queued.id)!.status, "failed");
  });

  test("unfinished jobs are listed after a restart for recovery", () => {
    const { store, dir, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    const queued = store.jobs.add(newJob(project.id, now())).job;
    const uncertain = advanceJob(advanceJob(queued, { status: "submitting" }, now()), { status: "uncertain" }, now());
    store.jobs.transition(queued, advanceJob(queued, { status: "submitting" }, now()));
    store.jobs.transition(store.jobs.getRequired(queued.id), { ...uncertain, revision: 2 });
    store.jobs.add(newJob(project.id, now()));
    store.close();
    const reopened = openStore(dir);
    cleanups.push(() => reopened.close());
    const unfinished = reopened.jobs.listUnfinished();
    assert.deepEqual(unfinished.map((job) => job.status), ["uncertain", "queued"]);
  });
});

describe("scripts", () => {
  test("versions are kept as history and a stale version conflicts", () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    const script = store.scripts.create(createScript(randomUUID(), project.id, "Cup holder", ridgelineBeats(), now()));
    const v2 = reviseScript(script, "Cup holder v2", ridgelineBeats().slice(0, 3), now()).script;
    store.scripts.saveVersion(v2);
    assert.equal(store.scripts.getRequired(script.id).version, 2);
    assert.equal(store.scripts.get(script.id, 1)?.beats.length, 4);
    assert.deepEqual(store.scripts.listVersions(script.id).map((entry) => entry.version), [1, 2]);
    const stale = reviseScript(script, "Other", ridgelineBeats(), now()).script;
    assert.throws(() => store.scripts.saveVersion({ ...stale, title: "Different" }), (e) => toFailure(e).code === "conflict");
  });
});
