import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { type Asset, AssetSchema, archiveAsset, markAssetDeleted, restoreAsset } from "@/lib/domain/asset";
import {
  type ContentPiece,
  addCandidates,
  approveCandidate,
  beginExport,
  completeExport,
  planShots,
  selectCandidate,
  updateCut,
} from "@/lib/domain/content";
import { ServiceError, toFailure } from "@/lib/domain/failure";
import { advanceJob, createJob } from "@/lib/domain/job";
import { MOCK_RECIPES } from "@/server/catalog/defaults";
import {
  type CharacterLink,
  approveReferenceSheet,
  chooseWardrobe,
  createCharacter,
  linkToProject,
  reviseCharacterBible,
  setCharacterReference,
} from "@/lib/domain/library";
import { createProject, saveBrief } from "@/lib/domain/project";
import { createScript } from "@/lib/domain/script";
import { assertArchivable, findAssetUsage, planDeleteEverywhere } from "@/lib/domain/usage";
import { DEFAULT_WORKSPACE_SETTINGS, effectiveAllowanceUsd, updateWorkspaceSettings } from "@/lib/domain/workspace";
import { averyBible, ridgelineBeats } from "./support/domain-fixtures";

const NOW = 1_760_000_000_000;

function asset(overrides: Partial<Asset> = {}): Asset {
  const id = overrides.id ?? randomUUID();
  return AssetSchema.parse({
    id,
    projectId: randomUUID(),
    kind: "image",
    mime: "image/png",
    relativePath: `media/${id}.png`,
    width: 1080,
    height: 1920,
    sha256: "a".repeat(64),
    provenance: { source: "generated", recipeId: "mock-still", jobId: randomUUID(), prompt: "p", inputs: [], mock: true },
    state: { state: "active" },
    revision: 0,
    createdAt: NOW,
    ...overrides,
  });
}

function code(error: unknown): string {
  return toFailure(error).code;
}

describe("failures", () => {
  test("ServiceError parses as a ServiceFailure", () => {
    assert.deepEqual(toFailure(new ServiceError("conflict", "Changed.")), { code: "conflict", message: "Changed." });
    assert.equal(toFailure(new Error("boom")).code, "storage");
  });
});

describe("workspace and project", () => {
  test("allowance in force is the lower of the setting and the operator cap", () => {
    const settings = updateWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS, { allowanceUsd: 3 }, NOW);
    assert.equal(effectiveAllowanceUsd(settings, 5), 3);
    assert.equal(effectiveAllowanceUsd(settings, 0), 0);
    assert.equal(effectiveAllowanceUsd(settings, Number.NaN), 0);
    assert.equal(effectiveAllowanceUsd(DEFAULT_WORKSPACE_SETTINGS, 5), 0);
    assert.throws(() => updateWorkspaceSettings(settings, { autoApprove: true, revision: 0 }, NOW), (e) => code(e) === "conflict");
  });

  test("saving a brief bumps the project revision", () => {
    const project = createProject({ name: "Bottle launch" }, randomUUID(), NOW);
    assert.equal(project.appId, "ugc-creator");
    const next = saveBrief(
      project,
      { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters", platforms: ["TikTok"], tone: "Warm" },
      NOW + 1,
    );
    assert.equal(next.revision, 1);
    assert.equal(next.brief?.audience, "Commuters");
  });
});

describe("character references", () => {
  test("face before body, each lock bumps the bible version, revisions keep references", () => {
    const character = createCharacter(randomUUID(), averyBible(), NOW);
    assert.equal(character.bible.version, 1);
    const face = asset();
    const body = asset();
    assert.throws(() => setCharacterReference(character, "body", body, NOW), (e) => code(e) === "invalid");
    const withFace = setCharacterReference(character, "face", face, NOW + 1);
    const withBody = setCharacterReference(withFace, "body", body, NOW + 2);
    assert.equal(withBody.bible.version, 3);
    assert.equal(withBody.bible.references.faceAssetId, face.id);
    const revised = reviseCharacterBible(withBody, { ...averyBible(), build: "Tall and athletic" }, NOW + 3);
    assert.equal(revised.bible.version, 4);
    assert.equal(revised.bible.references.bodyAssetId, body.id);
    assert.throws(() => setCharacterReference(character, "face", archiveAsset(face, "x", NOW), NOW), (e) => code(e) === "invalid");
  });

  test("the visual core stays under 60 words", () => {
    assert.throws(() => createCharacter(randomUUID(), { ...averyBible(), visualCore: "word ".repeat(60) }, NOW));
  });

  test("reference sheet approval needs a wardrobe, a sheet from this project, and a new wardrobe withdraws it", () => {
    const character = createCharacter(randomUUID(), averyBible(), NOW);
    const projectId = randomUUID();
    const link = linkToProject(projectId, character, NOW) as CharacterLink;
    const sheet = asset({ kind: "sheet", projectId });
    assert.throws(() => approveReferenceSheet(link, sheet, NOW), (e) => code(e) === "invalid");
    const dressed = chooseWardrobe(link, "Oatmeal knit sweater and jeans", NOW + 1);
    assert.throws(() => approveReferenceSheet(dressed, asset({ kind: "image", projectId }), NOW), (e) => code(e) === "invalid");
    assert.throws(() => approveReferenceSheet(dressed, asset({ kind: "sheet" }), NOW), (e) => code(e) === "invalid");
    const approved = approveReferenceSheet(dressed, sheet, NOW + 2);
    assert.equal(approved.sheetAssetId, sheet.id);
    assert.equal(approved.sheetApprovedAt, NOW + 2);
    assert.equal(chooseWardrobe(approved, "Oatmeal knit sweater and jeans", NOW + 3), approved);
    const changed = chooseWardrobe(approved, "Olive utility jacket over a white tee", NOW + 3);
    assert.equal(changed.sheetAssetId, null);
    assert.equal(changed.sheetApprovedAt, null);
  });
});

describe("asset lifecycle", () => {
  test("archive, restore, and delete", () => {
    const original = asset();
    const archived = archiveAsset(original, "not selected", NOW);
    assert.deepEqual(archived.state, { state: "archived", reason: "not selected", archivedAt: NOW });
    assert.equal(archiveAsset(archived, "again", NOW + 1), archived);
    const restored = restoreAsset(archived);
    assert.equal(restored.state.state, "active");
    assert.equal(restored.revision, 2);
    const deleted = markAssetDeleted(restored, NOW + 2);
    assert.throws(() => restoreAsset(deleted), (e) => code(e) === "not_found");
    assert.throws(() => archiveAsset(deleted, "x", NOW), (e) => code(e) === "not_found");
  });
});

function adWithCandidates(): { content: ContentPiece; stills: string[]; clips: string[] } {
  const script = createScript(randomUUID(), randomUUID(), "Cup holder", ridgelineBeats(), NOW);
  let content = planShots(randomUUID(), script, "Cup holder ad", NOW, randomUUID);
  const stills = [randomUUID(), randomUUID(), randomUUID()];
  const clips = [randomUUID(), randomUUID()];
  content = addCandidates(content, 1, "still", stills, NOW + 1);
  content = addCandidates(content, 1, "clip", clips, NOW + 2);
  return { content, stills, clips };
}

describe("shots", () => {
  test("plan creates one empty shot per beat in cut order", () => {
    const script = createScript(randomUUID(), randomUUID(), "Cup holder", ridgelineBeats(), NOW);
    const content = planShots(randomUUID(), script, "Cup holder ad", NOW, randomUUID);
    assert.equal(content.shots.length, 4);
    assert.deepEqual(content.cut.order, content.shots.map((shot) => shot.id));
    assert.ok(content.shots.every((shot) => shot.still.state === "empty"));
  });

  test("select, approve with siblings, clip after still, re-approving a still withdraws the clip", () => {
    const { content, stills, clips } = adWithCandidates();
    assert.equal(content.shots[0].still.state, "open");
    assert.throws(() => selectCandidate(content, 1, "still", randomUUID(), NOW), (e) => code(e) === "invalid");
    const selected = selectCandidate(content, 1, "still", stills[1], NOW + 3);
    assert.deepEqual(selected.shots[0].still, { state: "open", candidateIds: stills, selectedId: stills[1] });
    assert.throws(() => approveCandidate(selected, 1, "clip", clips[0], NOW), (e) => code(e) === "invalid");
    const still = approveCandidate(selected, 1, "still", stills[1], NOW + 4);
    assert.deepEqual(still.siblingIds, [stills[0], stills[2]]);
    assert.throws(() => selectCandidate(still.content, 1, "still", stills[0], NOW), (e) => code(e) === "conflict");
    const clip = approveCandidate(still.content, 1, "clip", clips[0], NOW + 5);
    assert.equal(clip.content.shots[0].clip.state, "approved");
    assert.equal(approveCandidate(clip.content, 1, "clip", clips[0], NOW + 6).content, clip.content);
    const other = approveCandidate(clip.content, 1, "still", stills[2], NOW + 7);
    assert.equal(other.content.shots[0].clip.state, "open");
    assert.equal(other.content.shots[0].still.state, "approved");
  });

  test("new candidates keep an existing approval", () => {
    const { content, stills } = adWithCandidates();
    const approved = approveCandidate(content, 1, "still", stills[0], NOW).content;
    const more = addCandidates(approved, 1, "still", [randomUUID()], NOW + 1);
    assert.equal(more.shots[0].still.state, "approved");
    assert.equal(more.shots[0].still.state === "approved" && more.shots[0].still.candidateIds.length, 4);
  });

  test("the cut orders every shot exactly once", () => {
    const { content } = adWithCandidates();
    const reversed = [...content.cut.order].reverse();
    assert.deepEqual(updateCut(content, { order: reversed, mute: true }, NOW).cut, {
      order: reversed,
      mute: true,
      captions: true,
    });
    assert.throws(() => updateCut(content, { order: reversed.slice(1) }, NOW), (e) => code(e) === "invalid");
    assert.throws(() => updateCut(content, { order: [reversed[0], ...reversed.slice(0, 3)] }, NOW), (e) => code(e) === "invalid");
  });
});

describe("delete everywhere", () => {
  function graphWithExport() {
    const projectId = randomUUID();
    const script = createScript(randomUUID(), projectId, "Short", [ridgelineBeats()[0]], NOW);
    const still = asset({ projectId });
    const clip = asset({ projectId, kind: "video", mime: "video/mp4", relativePath: "media/clip.mp4", video: { durationSeconds: 5, frameRate: 24, frameCount: 121, hasAudio: true, posterPath: "media/clip-poster.png" } });
    let content = planShots(randomUUID(), script, "Short ad", NOW, randomUUID);
    content = addCandidates(content, 1, "still", [still.id], NOW);
    content = approveCandidate(content, 1, "still", still.id, NOW).content;
    content = addCandidates(content, 1, "clip", [clip.id], NOW);
    content = approveCandidate(content, 1, "clip", clip.id, NOW).content;
    const record = completeExport(
      beginExport(randomUUID(), content, script, (id) => [still, clip].find((entry) => entry.id === id), NOW),
      randomUUID(),
      NOW + 1,
    );
    let character = createCharacter(randomUUID(), averyBible(), NOW);
    character = setCharacterReference(character, "face", still, NOW);
    return { still, clip, content, record, character, graph: { libraryItems: [character], links: [], contents: [content], exports: [record], assets: [still, clip] } };
  }

  test("refuses when an export depends on the asset unless forced, then marks dependents broken", () => {
    const { clip, graph } = graphWithExport();
    assert.throws(() => planDeleteEverywhere(graph, clip, { force: false, now: NOW }), (e) => code(e) === "conflict");
    const plan = planDeleteEverywhere(graph, clip, { force: true, now: NOW });
    assert.equal(plan.asset.state.state, "deleted");
    assert.deepEqual(plan.contents[0].shots[0].clip, { state: "empty" });
    assert.deepEqual(plan.contents[0].shots[0].brokenAssetIds, [clip.id]);
    assert.equal(plan.contents[0].shots[0].still.state, "approved");
    assert.deepEqual(plan.exports[0].brokenAssetIds, [clip.id]);
    assert.ok(plan.usage.some((entry) => entry.kind === "export_source"));
  });

  test("deleting a face reference clears it, bumps the bible, and marks the character broken", () => {
    const { still, graph, character } = graphWithExport();
    const plan = planDeleteEverywhere({ ...graph, exports: [] }, still, { force: false, now: NOW });
    const item = plan.libraryItems[0];
    assert.equal(item.kind === "character" && item.bible.references.faceAssetId, null);
    assert.equal(item.kind === "character" && item.bible.version, character.bible.version + 1);
    assert.deepEqual(item.brokenAssetIds, [still.id]);
    assert.equal(plan.contents[0].shots[0].still.state, "empty");
    assert.equal(plan.contents[0].shots[0].clip.state, "approved");
  });

  test("approved assets cannot be archived; plain candidates can", () => {
    const { still, clip, graph } = graphWithExport();
    assert.throws(() => assertArchivable(findAssetUsage(graph, still.id)), (e) => code(e) === "conflict");
    const looseCandidate = asset();
    assert.doesNotThrow(() => assertArchivable(findAssetUsage(graph, looseCandidate.id)));
    assert.ok(findAssetUsage(graph, clip.id).some((entry) => entry.kind === "shot_approval"));
  });
});

describe("jobs", () => {
  const request = { recipe: MOCK_RECIPES[0], input: { prompt: "p" } };

  test("allowed path from queued to completed bumps the revision each step", () => {
    let job = createJob(
      { id: randomUUID(), requestId: randomUUID(), projectId: randomUUID(), request },
      NOW,
    );
    assert.equal(job.status, "queued");
    job = advanceJob(job, { status: "submitting" }, NOW + 1);
    job = advanceJob(job, { status: "uncertain" }, NOW + 2);
    job = advanceJob(job, { status: "running", providerRef: "prompt-1", progress: 0.5 }, NOW + 3);
    job = advanceJob(job, { status: "retrieving", creditsUsed: 12 }, NOW + 4);
    job = advanceJob(job, { status: "completed", outputs: [randomUUID()] }, NOW + 5);
    assert.equal(job.revision, 5);
    assert.equal(job.progress, 1);
    assert.equal(job.providerRef, "prompt-1");
    assert.equal(job.creditsUsed, 12);
    assert.equal(job.recipeId, MOCK_RECIPES[0].id);
    assert.throws(() => advanceJob(job, { status: "running" }, NOW), (e) => code(e) === "conflict");
  });

  test("a queued job cannot jump to completed", () => {
    const job = createJob(
      { id: randomUUID(), requestId: randomUUID(), projectId: randomUUID(), request },
      NOW,
    );
    assert.throws(() => advanceJob(job, { status: "completed", outputs: [randomUUID()] }, NOW), (e) => code(e) === "conflict");
    const failed = advanceJob(job, { status: "failed", error: { code: "provider", message: "Rejected", retryable: false } }, NOW);
    assert.equal(failed.status, "failed");
  });
});
