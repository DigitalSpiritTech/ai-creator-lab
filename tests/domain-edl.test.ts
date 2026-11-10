/**
 * Take-then-cutaways domain (v0.2 F5): transcripts and their parsing, aligning beats to word
 * times, drafting and editing the EDL, the take slot, and the cutaway export record. Pure.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { type Asset, AssetSchema } from "@creator-lab/core/domain/asset";
import {
  type ContentPiece,
  ContentPieceSchema,
  ExportRecordSchema,
  addCandidates,
  addTakeCandidates,
  approveCandidate,
  approveTake,
  beginCutawayExport,
  planShots,
  setEdl,
  syncShotsToScript,
} from "@creator-lab/core/domain/content";
import { DocumentVersionSchema, versionSummary } from "@creator-lab/core/domain/document";
import { type Edl, draftEdl, reviseEdl, shiftWindow, syncEdlToScript } from "@creator-lab/core/domain/edl";
import { ServiceError } from "@creator-lab/core/domain/failure";
import { type Script, createScript, reviseScript } from "@creator-lab/core/domain/script";
import { alignBeats, lineWords, parseTranscript, wordSimilarity } from "@creator-lab/core/domain/transcript";
import { assertArchivable, findAssetUsage, planDeleteEverywhere } from "@creator-lab/core/domain/usage";
import { CUTAWAY_BEATS, TAKE_SECONDS, takeTranscriptFixture } from "./support/cutaway-fixtures";

const NOW = 1_760_000_000_000;
const SHA = (char: string) => char.repeat(64);

function script(): Script {
  return createScript(randomUUID(), randomUUID(), "Cup holder", CUTAWAY_BEATS, NOW);
}

function video(overrides: Partial<Asset> = {}): Asset {
  return AssetSchema.parse({
    id: randomUUID(),
    projectId: randomUUID(),
    kind: "video",
    mime: "video/mp4",
    relativePath: `media/${randomUUID()}.mp4`,
    width: 720,
    height: 1280,
    sha256: SHA("a"),
    provenance: { source: "upload", name: "clip.mp4", originalSha256: SHA("a") },
    state: { state: "active" },
    video: { durationSeconds: TAKE_SECONDS, frameRate: 24, frameCount: TAKE_SECONDS * 24, hasAudio: true },
    revision: 0,
    createdAt: NOW,
    ...overrides,
  });
}

function rejects(run: () => unknown, code: string, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => error instanceof ServiceError && error.code === code && pattern.test(error.message));
}

const transcript = () => parseTranscript(takeTranscriptFixture());

function drafted(take = video()): { edl: Edl; unplaced: number[]; take: Asset } {
  return { ...draftEdl({ script: script(), take: { assetId: take.id, sha256: take.sha256, durationSeconds: TAKE_SECONDS }, transcript: transcript(), transcriptAssetId: randomUUID() }), take };
}

describe("transcripts", () => {
  test("Whisper's segments with word timestamps, OpenAI's verbose_json, and the app's own shape all parse to one transcript", () => {
    const fromSegments = transcript();
    assert.equal(fromSegments.words.length, 17);
    assert.deepEqual(fromSegments.words[0], { text: "This", start: 0.3, end: 0.5, probability: 0.98 });
    assert.equal(fromSegments.durationSeconds, 8);
    assert.equal(fromSegments.language, "en");
    const openai = parseTranscript({ task: "transcribe", language: "english", duration: 2.5, text: "Link below.", words: [{ word: "Link", start: 0.4, end: 0.7 }, { word: "below.", start: 0.75, end: 1.2 }] });
    assert.deepEqual(openai.words.map((word) => word.text), ["Link", "below."]);
    assert.equal(openai.language, "english");
    assert.deepEqual(parseTranscript(fromSegments), fromSegments, "the app's own shape round-trips");
  });

  test("a result without word timestamps, or not a transcript at all, is refused", () => {
    assert.throws(() => parseTranscript({ text: "Link below." }), /no word timestamps/);
    assert.throws(() => parseTranscript("nope"), /not a Whisper transcript/);
  });

  test("words compare without case or punctuation; hyphens split; near misses on longer words still count", () => {
    assert.deepEqual(lineWords("Twenty-four hours, I checked!"), ["twenty", "four", "hours", "i", "checked"]);
    assert.equal(wordSimilarity("holder", "holder"), 2);
    assert.equal(wordSimilarity("bottles", "bottle"), 1);
    assert.equal(wordSimilarity("cup", "cap"), 0, "short words must match exactly");
  });
});

describe("aligning beats to the take", () => {
  test("each beat's line spans its first to last heard word", () => {
    const { spans, unplaced } = alignBeats(script().beats, transcript());
    assert.deepEqual(unplaced, []);
    assert.deepEqual(
      spans.map(({ beatIndex, start, end, estimated }) => ({ beatIndex, start, end, estimated })),
      [
        { beatIndex: 1, start: 0.3, end: 1.7, estimated: false },
        { beatIndex: 2, start: 2.2, end: 3.8, estimated: false },
        { beatIndex: 3, start: 4.3, end: 5.8, estimated: false },
        { beatIndex: 4, start: 6.4, end: 7.2, estimated: false },
      ],
    );
    assert.ok(spans.every((span) => span.matchedWords === span.totalWords));
  });

  test("misheard, dropped, and extra words never shift a beat", () => {
    const heard = transcript();
    const words = heard.words
      .map((word) => (word.text === "holder." ? { ...word, text: "holders." } : word))
      .filter((word) => word.text !== "every")
      .flatMap((word) => (word.text === "Still" ? [{ text: "um,", start: 4.0, end: 4.2 }, word] : [word]));
    const { spans } = alignBeats(script().beats, { ...heard, words });
    assert.equal(spans[0].end, 1.7, "holders still matches holder");
    assert.equal(spans[1].matchedWords, 4, "beat 2 lost one word");
    assert.equal(spans[2].start, 4.3, "the filler word before beat 3 is not part of it");
  });

  test("beats none of whose words were heard share the gap their neighbours leave, by word count", () => {
    const heard = transcript();
    const words = heard.words.filter((word) => word.start < 2 || word.start > 6);
    const { spans } = alignBeats(script().beats, { ...heard, words });
    const estimated = spans.filter((span) => span.estimated);
    assert.deepEqual(estimated.map((span) => span.beatIndex), [2, 3]);
    assert.equal(estimated[0].start, 1.7);
    assert.equal(estimated[1].end, 6.4);
    assert.ok(Math.abs(estimated[0].end - estimated[1].start) < 0.001, "the two estimates abut");
  });
});

describe("the edit decision list", () => {
  test("the draft puts each b-roll line in a window up to the next line, and each beat's on-screen text in a caption", () => {
    const { edl, unplaced } = drafted();
    assert.deepEqual(unplaced, []);
    assert.deepEqual(edl.windows, [
      { beatIndex: 2, start: 2.2, end: 4.3 },
      { beatIndex: 4, start: 6.4, end: 8 },
    ]);
    assert.deepEqual(edl.captions, [
      { start: 0.3, end: 2.2, text: "Fits the cup holder." },
      { start: 2.2, end: 4.3, text: "Warm by noon." },
      { start: 4.3, end: 6.4, text: "Cold 24 hours: I checked." },
    ]);
    assert.equal(edl.beats.length, 4);
    assert.match(versionSummary(DocumentVersionSchema.parse({ kind: "edl", subjectId: randomUUID(), version: 1, author: "user", restoredFrom: null, createdAt: NOW, content: edl })), /beat 2 2\.2-4\.3 s/);
  });

  test("a b-roll beat with no line has no time on the take, so the draft names it unplaced", () => {
    const beats = CUTAWAY_BEATS.map((beat, index) => (index === 3 ? { ...beat, spokenLine: "" } : beat));
    const silent = createScript(randomUUID(), randomUUID(), "Cup holder", beats, NOW);
    const take = video();
    const { edl, unplaced } = draftEdl({ script: silent, take: { assetId: take.id, sha256: take.sha256, durationSeconds: 8 }, transcript: transcript(), transcriptAssetId: randomUUID() });
    assert.deepEqual(unplaced, [4]);
    assert.deepEqual(edl.windows.map((window) => window.beatIndex), [2]);
  });

  test("moving a window by two seconds keeps its length; leaving the take or overlapping another is refused", () => {
    const { edl } = drafted();
    const moved = shiftWindow(edl, 2, 2);
    assert.deepEqual(moved.windows[0], { beatIndex: 2, start: 4.2, end: 6.3 });
    assert.deepEqual(moved.windows[1], edl.windows[1], "the other window stays");
    assert.deepEqual(moved.captions, edl.captions, "captions follow the take's words, not the window");
    rejects(() => shiftWindow(edl, 2, 2.5), "invalid", /overlap/);
    rejects(() => shiftWindow(edl, 4, 1), "invalid", /leave the take/);
    rejects(() => shiftWindow(edl, 3, 1), "not_found", /No window shows beat 3/);
  });

  test("edits are sorted and rounded, and refused when they break a rule", () => {
    const { edl } = drafted();
    const beats = script();
    const revised = reviseEdl(edl, { windows: [{ beatIndex: 4, start: 6.40001, end: 7.5 }, { beatIndex: 2, start: 1, end: 2 }] }, beats);
    assert.deepEqual(revised.windows, [{ beatIndex: 2, start: 1, end: 2 }, { beatIndex: 4, start: 6.4, end: 7.5 }]);
    rejects(() => reviseEdl(edl, { windows: [{ beatIndex: 2, start: 1, end: 3 }, { beatIndex: 4, start: 2.5, end: 4 }] }, beats), "invalid", /do not overlap/);
    rejects(() => reviseEdl(edl, { windows: [{ beatIndex: 2, start: 7, end: 9 }] }, beats), "invalid", /inside the take/);
    rejects(() => reviseEdl(edl, { windows: [{ beatIndex: 2, start: 1, end: 1.2 }] }, beats), "invalid", /at least 0\.5 s/);
    rejects(() => reviseEdl(edl, { windows: [{ beatIndex: 1, start: 1, end: 2 }] }, beats), "invalid", /talking beat/);
    rejects(() => reviseEdl(edl, { windows: [{ beatIndex: 9, start: 1, end: 2 }] }, beats), "invalid", /not in the script/);
    rejects(() => reviseEdl(edl, { captions: [{ start: 1, end: 3, text: "One" }, { start: 2, end: 4, text: "Two" }] }, beats), "invalid", /Captions are in time order/);
    const recaptioned = reviseEdl(edl, { captions: [{ start: 5, end: 6, text: "Cold 24 hours." }] }, beats);
    assert.deepEqual(recaptioned.windows, edl.windows, "a caption edit keeps the windows");
  });

  test("after a script revision, windows of removed beats and of beats that became talking are dropped", () => {
    const { edl } = drafted();
    const talking = CUTAWAY_BEATS.map((beat, index) => (index === 3 ? { ...beat, type: "talking" as const } : beat));
    assert.deepEqual(syncEdlToScript(edl, createScript(randomUUID(), randomUUID(), "t", talking, NOW).beats).windows.map((window) => window.beatIndex), [2]);
    assert.deepEqual(syncEdlToScript(edl, createScript(randomUUID(), randomUUID(), "t", CUTAWAY_BEATS.slice(0, 3), NOW).beats).windows.map((window) => window.beatIndex), [2]);
    assert.equal(syncEdlToScript(edl, script().beats), edl, "unchanged when every window still fits");
  });
});

describe("the take slot and the cutaway export", () => {
  function approvedAd(): { content: ContentPiece; script: Script; take: Asset; clips: Asset[]; edl: Edl } {
    const beats = script();
    let content = planShots(randomUUID(), beats, "Ad", NOW, randomUUID);
    const clips = beats.beats.map(() => video({ sha256: SHA("c") }));
    for (const beat of beats.beats) {
      content = addCandidates(content, beat.index, "still", [clips[beat.index - 1].id], NOW);
      content = approveCandidate(content, beat.index, "still", clips[beat.index - 1].id, NOW).content;
      content = addCandidates(content, beat.index, "clip", [clips[beat.index - 1].id], NOW);
      content = approveCandidate(content, beat.index, "clip", clips[beat.index - 1].id, NOW).content;
    }
    const take = video({ sha256: SHA("b") });
    const other = video({ sha256: SHA("d") });
    content = addTakeCandidates(content, [take.id, other.id], NOW);
    const approved = approveTake(content, take.id, NOW);
    assert.deepEqual(approved.siblingIds, [other.id]);
    const { edl } = draftEdl({ script: beats, take: { assetId: take.id, sha256: take.sha256, durationSeconds: TAKE_SECONDS }, transcript: transcript(), transcriptAssetId: randomUUID() });
    return { content: setEdl(approved.content, edl, NOW), script: beats, take, clips, edl };
  }

  test("an Ad saved before takes existed parses with an empty take and no EDL", () => {
    const content = planShots(randomUUID(), script(), "Ad", NOW, randomUUID);
    const { take, edl, ...old } = content;
    assert.deepEqual([take, edl], [{ state: "empty" }, null]);
    const parsed = ContentPieceSchema.parse(old);
    assert.deepEqual(parsed.take, { state: "empty" });
    assert.equal(parsed.edl, null);
  });

  test("approving a take that is not a candidate is refused", () => {
    const content = planShots(randomUUID(), script(), "Ad", NOW, randomUUID);
    rejects(() => approveTake(content, randomUUID(), NOW), "invalid", /takes/);
  });

  test("a changed line withdraws the take's approval; an on-screen text edit keeps it", () => {
    const { content, script: beats } = approvedAd();
    const textOnly = reviseScript(beats, beats.title, CUTAWAY_BEATS.map((beat, index) => (index === 0 ? { ...beat, onScreenText: "Cup holder sized." } : beat)), NOW);
    assert.equal(syncShotsToScript(content, textOnly.script, textOnly.change, NOW, randomUUID).take.state, "approved");
    const lineEdit = reviseScript(beats, beats.title, CUTAWAY_BEATS.map((beat, index) => (index === 1 ? { ...beat, spokenLine: "Warm by lunch." } : beat)), NOW);
    const synced = syncShotsToScript(content, lineEdit.script, lineEdit.change, NOW, randomUUID);
    assert.equal(synced.take.state, "open", "the take says the old line");
    assert.ok(synced.edl, "the EDL is kept for the next take");
  });

  test("the cutaway export freezes the take, each window's approved clip, and the captions", () => {
    const { content, script: beats, take, clips, edl } = approvedAd();
    const assets = new Map([take, ...clips].map((asset) => [asset.id, asset]));
    const record = beginCutawayExport(randomUUID(), content, beats, 3, (id) => assets.get(id), NOW);
    assert.equal(record.strategy, "take_cutaways");
    assert.deepEqual(record.take, { assetId: take.id, sha256: take.sha256, durationSeconds: TAKE_SECONDS });
    assert.equal(record.edlVersion, 3);
    assert.deepEqual(record.sources.map((source) => [source.beatIndex, source.assetId, source.window]), [
      [2, clips[1].id, { start: 2.2, end: 4.3 }],
      [4, clips[3].id, { start: 6.4, end: 8 }],
    ]);
    assert.equal(record.sources[0].durationSeconds, (103 - 53) / 24, "whole frames between the window's edges");
    assert.deepEqual(record.captionCues, edl.captions);
    assert.equal(ExportRecordSchema.safeParse({ ...record, take: undefined }).success, false, "a cutaway export names its take");
  });

  test("the cutaway export refuses, naming the fix, without a take, an EDL, the same take, or a window's clip", () => {
    const { content, script: beats, take, clips } = approvedAd();
    const assets = new Map([take, ...clips].map((asset) => [asset.id, asset]));
    const find = (id: string) => assets.get(id);
    rejects(() => beginCutawayExport(randomUUID(), { ...content, take: { state: "empty" } }, beats, 1, find, NOW), "invalid", /Approve a talking take/);
    rejects(() => beginCutawayExport(randomUUID(), { ...content, edl: null }, beats, 1, find, NOW), "invalid", /save_edl/);
    const other = video({ sha256: SHA("e") });
    assets.set(other.id, other);
    const swapped = approveTake(addTakeCandidates(content, [other.id], NOW), other.id, NOW).content;
    rejects(() => beginCutawayExport(randomUUID(), swapped, beats, 1, find, NOW), "conflict", /another take/);
    assets.set(take.id, { ...take, video: { ...take.video!, hasAudio: false } });
    rejects(() => beginCutawayExport(randomUUID(), content, beats, 1, find, NOW), "invalid", /no sound/);
    assets.set(take.id, take);
    const noClip = { ...content, shots: content.shots.map((shot) => (shot.beatIndex === 4 ? { ...shot, clip: { state: "empty" as const } } : shot)) };
    rejects(() => beginCutawayExport(randomUUID(), noClip, beats, 1, find, NOW), "invalid", /Beat 4 fills a window but has no approved clip/);
  });

  test("the approved take blocks archiving; deleting it everywhere clears the take and its EDL, a transcript only unlinks", () => {
    const { content, take, edl } = approvedAd();
    const graph = { libraryItems: [], links: [], contents: [content], exports: [], assets: [take] };
    const usage = findAssetUsage(graph, take.id);
    assert.deepEqual(usage.map((entry) => entry.kind).sort(), ["edl_source", "take_approval"]);
    assert.throws(() => assertArchivable(usage), /approved/);
    const plan = planDeleteEverywhere(graph, take, { force: false, now: NOW });
    assert.equal(plan.contents[0].take.state, "open");
    assert.equal(plan.contents[0].edl, null);
    const transcriptAsset = AssetSchema.parse({
      id: edl.transcriptAssetId!,
      projectId: take.projectId,
      kind: "transcript",
      mime: "application/json",
      relativePath: `media/${edl.transcriptAssetId}.json`,
      width: 0,
      height: 0,
      sha256: SHA("f"),
      provenance: { source: "generated", recipeId: "mock-speech-to-text", jobId: randomUUID(), prompt: "This fits", inputs: [{ assetId: take.id, sha256: take.sha256 }], mock: true },
      state: { state: "active" },
      transcription: { durationSeconds: 8, wordCount: 17, language: "en" },
      revision: 0,
      createdAt: NOW,
    });
    const unlinked = planDeleteEverywhere({ ...graph, assets: [take, transcriptAsset] }, transcriptAsset, { force: false, now: NOW });
    assert.equal(unlinked.contents[0].edl?.transcriptAssetId, null);
    assert.deepEqual(unlinked.contents[0].edl?.windows, edl.windows, "the windows still cut");
    assert.equal(AssetSchema.safeParse({ ...transcriptAsset, transcription: undefined }).success, false, "a transcript carries its word count");
  });

  test("an export cut from a take depends on it", () => {
    const { content, script: beats, take, clips } = approvedAd();
    const assets = new Map([take, ...clips].map((asset) => [asset.id, asset]));
    const record = beginCutawayExport(randomUUID(), content, beats, 1, (id) => assets.get(id), NOW);
    const usage = findAssetUsage({ libraryItems: [], links: [], contents: [], exports: [record], assets: [] }, take.id);
    assert.deepEqual(usage, [{ kind: "export_source", exportId: record.id }]);
    assert.throws(() => planDeleteEverywhere({ libraryItems: [], links: [], contents: [], exports: [record], assets: [] }, take, { force: false, now: NOW }), /An export depends/);
  });
});
