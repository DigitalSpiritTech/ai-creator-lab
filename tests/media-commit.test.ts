import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import sharp from "sharp";
import { addCandidates, approveCandidate, planShots } from "@/lib/domain/content";
import { toFailure } from "@/lib/domain/failure";
import { advanceJob, createJob } from "@/lib/domain/job";
import { MOCK_RECIPES } from "@/server/catalog/defaults";
import { createScript } from "@/lib/domain/script";
import { assetResponse, parseByteRange } from "@/server/media/asset-response";
import { commitJobOutputs } from "@/server/media/commit";
import { readAssetBytes } from "@/server/media/files";
import { importImage } from "@/server/media/images";
import { readJobInputs } from "@/server/media/job-input";
import { archiveStoredAsset, deleteAssetEverywhere, restoreStoredAsset } from "@/server/media/lifecycle";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import { checkProbe } from "@/server/media/video";
import { clock, generateAssets, ridgelineBeats, seedProject, tempStore } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const project = seedProject(context.store, now);
  return { ...context, now, project };
}

function mediaFiles(dir: string): string[] {
  return readdirSync(join(dir, "media"));
}

describe("paths and ranges", () => {
  test("media paths cannot escape the data directory", () => {
    assert.throws(() => resolveMediaPath("/tmp/data", "../etc/passwd"));
    assert.throws(() => resolveMediaPath("/tmp/data", "media/../../x"));
    assert.equal(resolveMediaPath("/tmp/data", "media/a.png"), "/tmp/data/media/a.png");
  });

  test("byte ranges", () => {
    assert.deepEqual(parseByteRange(null, 10), { kind: "full", start: 0, end: 9 });
    assert.deepEqual(parseByteRange("bytes=2-4", 10), { kind: "partial", start: 2, end: 4 });
    assert.deepEqual(parseByteRange("bytes=-3", 10), { kind: "partial", start: 7, end: 9 });
    assert.deepEqual(parseByteRange("bytes=8-", 10), { kind: "partial", start: 8, end: 9 });
    assert.deepEqual(parseByteRange("bytes=10-", 10), { kind: "unsatisfiable" });
    assert.deepEqual(parseByteRange("bytes=-", 10), { kind: "unsatisfiable" });
    assert.deepEqual(parseByteRange("items=1-2", 10), { kind: "unsatisfiable" });
  });
});

describe("atomic output commit", () => {
  test("writes files, completes the job, inserts assets, and attaches candidates to the shot", async () => {
    const { store, dir, now, project } = setup();
    const script = store.scripts.create(createScript(randomUUID(), project.id, "Cup holder", ridgelineBeats(), now()));
    const content = store.content.create(planShots(randomUUID(), script, "Ad", now(), randomUUID));
    const { job, assetIds } = await generateAssets(store, now, {
      projectId: project.id,
      count: 3,
      target: { kind: "shot", contentId: content.id, beatIndex: 2, slot: "still" },
    });
    assert.equal(job.status, "completed");
    assert.equal(mediaFiles(dir).length, 3);
    const saved = store.content.getRequired(content.id);
    assert.deepEqual(saved.shots[1].still, { state: "open", candidateIds: assetIds, selectedId: null });
    const asset = store.assets.getRequired(assetIds[0]);
    assert.equal(asset.provenance.source === "generated" && asset.provenance.mock, true);
    assert.equal(sha256(await readAssetBytes(store.dataDir, asset)), asset.sha256);
  });

  test("a lost race writes nothing and removes its files", async () => {
    const { store, dir, now, project } = setup();
    let job = store.jobs.add(
      createJob(
        { id: randomUUID(), requestId: randomUUID(), projectId: project.id, request: { recipe: MOCK_RECIPES[0], input: { prompt: "p" } } },
        now(),
      ),
    ).job;
    for (const status of ["submitting", "running", "retrieving"] as const) {
      const next = advanceJob(job, { status }, now());
      store.jobs.transition(job, next);
      job = next;
    }
    const output = { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" as const, kind: "image" as const, width: 1, height: 1 };
    const first = await commitJobOutputs(store, job, [output], { now: now(), newId: randomUUID });
    assert.equal(first.committed, true);
    const second = await commitJobOutputs(store, job, [output], { now: now(), newId: randomUUID });
    assert.equal(second.committed, false);
    assert.equal(second.job.status, "completed");
    assert.equal(mediaFiles(dir).length, 1);
    assert.equal(store.assets.list({ projectId: project.id }).length, 1);
  });

  test("a failing transaction removes written files and leaves the job unfinished", async () => {
    const { store, dir, now, project } = setup();
    let job = store.jobs.add(
      createJob(
        { id: randomUUID(), requestId: randomUUID(), projectId: project.id, request: { recipe: MOCK_RECIPES[0], input: { prompt: "p" } } },
        now(),
      ),
    ).job;
    const next = advanceJob(job, { status: "submitting" }, now());
    store.jobs.transition(job, next);
    job = next;
    const output = { bytes: new Uint8Array([1]), mime: "image/png" as const, kind: "image" as const, width: 1, height: 1 };
    await assert.rejects(commitJobOutputs(store, job, [output], { now: now(), newId: randomUUID }), (e) => toFailure(e).code === "conflict");
    assert.equal(mediaFiles(dir).length, 0);
    assert.equal(store.jobs.getRequired(job.id).status, "submitting");
  });

  test("job inputs are read back only when their bytes still match", async () => {
    const { store, now, project } = setup();
    const source = await generateAssets(store, now, { projectId: project.id });
    const sourceAsset = store.assets.getRequired(source.assetIds[0]);
    const { job } = await generateAssets(store, now, {
      projectId: project.id,
      inputs: [{ role: "image1", assetId: sourceAsset.id, sha256: sourceAsset.sha256 }],
    });
    const inputs = await readJobInputs(store, job);
    assert.equal(inputs[0].role, "image1");
    writeFileSync(resolveMediaPath(store.dataDir, sourceAsset.relativePath), "tampered");
    await assert.rejects(readJobInputs(store, job), (e) => toFailure(e).code === "storage");
  });
});

describe("uploads", () => {
  test("images are normalized to PNG, deduplicated, and invalid bytes are refused", async () => {
    const { store, now, project } = setup();
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#4a7" } }).jpeg().toBuffer();
    const first = await importImage(store, { projectId: project.id, name: "bottle.jpg", bytes: jpeg }, { now: now(), newId: randomUUID });
    assert.equal(first.mime, "image/png");
    assert.equal(first.width, 64);
    assert.ok(first.relativePath.startsWith("references/"));
    const again = await importImage(store, { projectId: project.id, name: "bottle.jpg", bytes: jpeg }, { now: now(), newId: randomUUID });
    assert.equal(again.id, first.id);
    const library = await importImage(store, { projectId: null, name: "bottle.jpg", bytes: jpeg }, { now: now(), newId: randomUUID });
    assert.notEqual(library.id, first.id);
    await assert.rejects(
      importImage(store, { projectId: project.id, name: "x.svg", bytes: new TextEncoder().encode("<svg/>") }, { now: now(), newId: randomUUID }),
      (e) => toFailure(e).code === "invalid",
    );
  });
});

describe("archive and delete everywhere", () => {
  test("approved assets are protected from archive; candidates archive and restore", async () => {
    const { store, now, project } = setup();
    const script = store.scripts.create(createScript(randomUUID(), project.id, "Cup holder", ridgelineBeats(), now()));
    const { assetIds } = await generateAssets(store, now, { projectId: project.id, count: 2 });
    let content = planShots(randomUUID(), script, "Ad", now(), randomUUID);
    content = addCandidates(content, 1, "still", assetIds, now());
    content = approveCandidate(content, 1, "still", assetIds[0], now()).content;
    store.content.create(content);
    assert.throws(() => archiveStoredAsset(store, assetIds[0], "retired", now()), (e) => toFailure(e).code === "conflict");
    assert.equal(archiveStoredAsset(store, assetIds[1], "not selected", now()).state.state, "archived");
    assert.equal(restoreStoredAsset(store, assetIds[1]).state.state, "active");
  });

  test("deletes the file, tombstones the row, and refuses an export dependency unless forced", async () => {
    const { store, dir, now, project } = setup();
    const script = store.scripts.create(createScript(randomUUID(), project.id, "Short", [ridgelineBeats()[0]], now()));
    const still = await generateAssets(store, now, { projectId: project.id });
    const clip = await generateAssets(store, now, { projectId: project.id, kind: "video" });
    let content = planShots(randomUUID(), script, "Ad", now(), randomUUID);
    content = addCandidates(content, 1, "still", still.assetIds, now());
    content = approveCandidate(content, 1, "still", still.assetIds[0], now()).content;
    content = addCandidates(content, 1, "clip", clip.assetIds, now());
    content = approveCandidate(content, 1, "clip", clip.assetIds[0], now()).content;
    store.content.create(content);
    const clipAsset = store.assets.getRequired(clip.assetIds[0]);
    store.content.addExport({
      id: randomUUID(),
      contentId: content.id,
      projectId: project.id,
      contentRevision: content.revision,
      scriptVersion: 1,
      options: { mute: false, captions: true },
      sources: [{ shotId: content.shots[0].id, beatIndex: 1, assetId: clipAsset.id, sha256: clipAsset.sha256, durationSeconds: 5, onScreenText: "" }],
      brokenAssetIds: [],
      createdAt: now(),
      status: "rendering",
    });
    await assert.rejects(deleteAssetEverywhere(store, clipAsset.id, { force: false, now: now() }), (e) => toFailure(e).code === "conflict");
    assert.ok(existsSync(resolveMediaPath(dir, clipAsset.relativePath)));
    const result = await deleteAssetEverywhere(store, clipAsset.id, { force: true, now: now() });
    assert.equal(result.asset.state.state, "deleted");
    assert.equal(existsSync(resolveMediaPath(dir, clipAsset.relativePath)), false);
    assert.equal(existsSync(resolveMediaPath(dir, clipAsset.video!.posterPath!)), false);
    assert.deepEqual(store.content.getRequired(content.id).shots[0].brokenAssetIds, [clipAsset.id]);
    assert.deepEqual(store.content.listExports(content.id)[0].brokenAssetIds, [clipAsset.id]);
    assert.equal(store.assets.getRequired(clipAsset.id).state.state, "deleted");
  });
});

describe("streaming", () => {
  test("serves partial content and refuses deleted assets", async () => {
    const { store, now, project } = setup();
    const { assetIds } = await generateAssets(store, now, { projectId: project.id });
    const asset = store.assets.getRequired(assetIds[0]);
    const response = await assetResponse(new Request("http://127.0.0.1/a", { headers: { range: "bytes=0-1" } }), asset, store.dataDir);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-length"), "2");
    assert.equal((await response.arrayBuffer()).byteLength, 2);
    const deleted = { ...asset, state: { state: "deleted" as const, deletedAt: now() } };
    assert.equal((await assetResponse(new Request("http://127.0.0.1/a"), deleted, store.dataDir)).status, 404);
  });
});

describe("video probe", () => {
  const probe = {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 720, height: 1280, pix_fmt: "yuv420p", avg_frame_rate: "24/1", nb_read_frames: "121", duration: "5.041667" },
      { codec_type: "audio", codec_name: "aac" },
    ],
    format: { duration: "5.05" },
  };

  test("accepts a matching clip and reports metadata", () => {
    const result = checkProbe(probe, { width: 720, height: 1280, frameRate: 24, frameCount: 121, requireAudio: true });
    assert.deepEqual(result, { width: 720, height: 1280, durationSeconds: 5.041667, frameRate: 24, frameCount: 121, hasAudio: true });
  });

  test("rejects a wrong size or codec", () => {
    assert.throws(() => checkProbe(probe, { width: 1080 }), (e) => toFailure(e).code === "provider");
    const hevc = { ...probe, streams: [{ ...probe.streams[0], codec_name: "hevc" }] };
    assert.throws(() => checkProbe(hevc), (e) => /codec/.test(toFailure(e).message));
  });
});
