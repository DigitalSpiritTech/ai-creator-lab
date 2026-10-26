import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { addCandidates, approveCandidate, planShots, syncShotsToScript } from "@/lib/domain/content";
import { BeatInputSchema, createScript, reviseScript } from "@/lib/domain/script";
import { ridgelineBeats } from "./support/domain-fixtures";

const NOW = 1_760_000_000_000;

describe("beats", () => {
  test("talking beats need a short spoken line and on-screen text stays small", () => {
    assert.ok(BeatInputSchema.safeParse(ridgelineBeats()[0]).success);
    assert.equal(BeatInputSchema.safeParse({ ...ridgelineBeats()[0], spokenLine: "" }).success, false);
    assert.equal(BeatInputSchema.safeParse({ ...ridgelineBeats()[0], spokenLine: "word ".repeat(16) }).success, false);
    assert.equal(BeatInputSchema.safeParse({ ...ridgelineBeats()[1], onScreenText: "one two three four five six seven" }).success, false);
    assert.equal(BeatInputSchema.safeParse({ ...ridgelineBeats()[1], onScreenText: "a\nb\nc" }).success, false);
    assert.ok(BeatInputSchema.safeParse({ ...ridgelineBeats()[1], onScreenText: "Warm by noon.\nEvery day." }).success);
  });

  test("beats are numbered from 1 and default to five seconds", () => {
    const script = createScript(randomUUID(), randomUUID(), "Cup holder", ridgelineBeats(), NOW);
    assert.deepEqual(script.beats.map((beat) => beat.index), [1, 2, 3, 4]);
    assert.ok(script.beats.every((beat) => beat.durationSeconds === 5));
    assert.equal(script.version, 1);
  });
});

describe("script revision", () => {
  const original = createScript(randomUUID(), randomUUID(), "Cup holder", ridgelineBeats(), NOW);

  test("a visual change invalidates still and clip; a spoken-line change only the clip; text edits nothing", () => {
    const beats = ridgelineBeats();
    beats[0] = { ...beats[0], visual: "Avery in the passenger seat holding the Ridgeline bottle." };
    beats[2] = { ...beats[2], spokenLine: "A full day later it was still cold." };
    beats[3] = { ...beats[3], onScreenText: "Goes in the dishwasher.", notes: "Close-up" };
    const { script, change } = reviseScript(original, "Cup holder v2", beats, NOW + 1);
    assert.equal(script.version, 2);
    assert.deepEqual(change, { stillInvalidated: [1], clipInvalidated: [1, 3], added: [], removed: [] });
  });

  test("setting and product visibility count as visual changes", () => {
    const beats = ridgelineBeats();
    beats[1] = { ...beats[1], setting: "a gym bench" };
    beats[3] = { ...beats[3], productVisible: false };
    assert.deepEqual(reviseScript(original, "v2", beats, NOW).change.stillInvalidated, [2, 4]);
  });

  test("added and removed beats are reported", () => {
    assert.deepEqual(reviseScript(original, "short", ridgelineBeats().slice(0, 3), NOW).change.removed, [4]);
    const longer = [...ridgelineBeats(), { type: "textcard" as const, purpose: "cta" as const, onScreenText: "Link in bio.", visual: "Last frame of beat four." }];
    assert.deepEqual(reviseScript(original, "long", longer, NOW).change.added, [5]);
  });

  test("syncing shots withdraws approvals only on changed beats and keeps candidates and cut order", () => {
    let content = planShots(randomUUID(), original, "Cup holder ad", NOW, randomUUID);
    const stillOne = randomUUID();
    const stillTwo = randomUUID();
    const clipTwo = randomUUID();
    content = addCandidates(content, 1, "still", [stillOne], NOW);
    content = approveCandidate(content, 1, "still", stillOne, NOW).content;
    content = addCandidates(content, 2, "still", [stillTwo], NOW);
    content = approveCandidate(content, 2, "still", stillTwo, NOW).content;
    content = addCandidates(content, 2, "clip", [clipTwo], NOW);
    content = approveCandidate(content, 2, "clip", clipTwo, NOW).content;
    const beats = ridgelineBeats().slice(0, 3);
    beats[0] = { ...beats[0], visual: "Avery leaning on the car door with the bottle." };
    const revised = reviseScript(original, "v2", beats, NOW + 1);
    const synced = syncShotsToScript(content, revised.script, revised.change, NOW + 2, randomUUID);
    assert.equal(synced.scriptVersion, 2);
    assert.equal(synced.shots.length, 3);
    assert.deepEqual(synced.shots[0].still, { state: "open", candidateIds: [stillOne], selectedId: null });
    assert.equal(synced.shots[1].still.state, "approved");
    assert.equal(synced.shots[1].clip.state, "approved");
    assert.deepEqual(synced.cut.order, content.cut.order.slice(0, 3));
    assert.equal(synced.shots[0].id, content.shots[0].id);
  });
});
