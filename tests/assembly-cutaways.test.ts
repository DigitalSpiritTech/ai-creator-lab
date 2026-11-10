/**
 * Take-then-cutaways acceptance (v0.2 F5): the mock executor makes a real take (lavfi picture and a
 * speech-like AAC track), the mock transcription returns the fixture's word timestamps, the EDL is
 * drafted and exported, one b-roll window is moved by two seconds, and the Ad is exported again.
 * Checked: no generation job is created by the EDL edit or either export, the take's sound is
 * identical in both exports (AAC packets and decoded PCM), the window moved (frame colors at the
 * old and new times against the b-roll source), and the captions follow the transcript's times.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";
import type { Asset } from "@creator-lab/core/domain/asset";
import { type ContentPiece, type ExportRecord, addCandidates } from "@creator-lab/core/domain/content";
import { type Edl, shiftWindow } from "@creator-lab/core/domain/edl";
import type { GenerationProposal } from "@creator-lab/core/domain/job";
import { MOCK_TAKE_COLOR, MockExecutor } from "@creator-lab/executors/mock";
import { planCutaways } from "@/server/assembly/cutaway";
import { resolveMediaPath } from "@/server/media/paths";
import { type ToolContext, callTool, createGenerationContext } from "@/server/tools";
import { ffmpeg, frameAt, importClip, meanColor } from "./support/assembly-fixtures";
import { CUTAWAY_BEATS, TAKE_SECONDS, takeTranscriptFixture } from "./support/cutaway-fixtures";
import { clock, seedProject, tempStore } from "./support/domain-fixtures";

const execute = promisify(execFile);
const workflowsDir = fileURLToPath(new URL("../packages/recipes/workflows", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function ok<T>(tools: ToolContext, name: string, input: unknown): Promise<T> {
  const result = await callTool(tools, name, input);
  if (!result.ok) assert.fail(`${name} failed: ${result.failure.code} ${result.failure.message}`);
  return result.output as T;
}

async function submit(tools: ToolContext, proposal: GenerationProposal): Promise<string[]> {
  const submitted = await ok<{ results: { outcome: string; assetIds: string[]; message: string | null }[] }>(tools, "submit_proposal", { proposal, wait: true });
  for (const result of submitted.results) assert.equal(result.outcome, "completed", result.message ?? "");
  return submitted.results.flatMap((result) => result.assetIds);
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The first audio stream as its AAC packets (ADTS framing), and decoded to 16-bit PCM. */
async function audioOf(path: string): Promise<{ packets: string; pcm: string; samples: number }> {
  const options = { encoding: "buffer" as const, maxBuffer: 64_000_000, timeout: 60_000 };
  const packets = await execute(ffmpeg(), ["-v", "error", "-i", path, "-map", "0:a:0", "-c:a", "copy", "-f", "adts", "-"], options);
  const pcm = await execute(ffmpeg(), ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-"], options);
  return { packets: sha(packets.stdout), pcm: sha(pcm.stdout), samples: pcm.stdout.length / 2 };
}

const TOP = { x: 140, y: 240, width: 800, height: 400 };
/** The caption band: both caption lines sit between about 1400 and 1500 px (baseline at 78 percent). */
const BAND = { x: 60, y: 1360, width: 960, height: 160 };

function near(actual: [number, number, number], expected: [number, number, number], tolerance = 14): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

/** Pixels in the caption band bright enough to be caption text (white), none of which the sources have. */
async function captionPixels(path: string, seconds: number): Promise<number> {
  const pixels = await frameAt(path, seconds, BAND);
  let count = 0;
  for (let index = 0; index < pixels.length; index += 3) if (pixels[index] > 225 && pixels[index + 1] > 225 && pixels[index + 2] > 225) count++;
  return count;
}

describe("take-then-cutaways export", () => {
  test("an EDL edit moves a b-roll window by 2 s and the re-export reflects it with no new generation and the same take audio", async () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const base = createGenerationContext(store, { workflowsDir });
    const mock = new MockExecutor({ jobs: store.jobs, transcript: () => takeTranscriptFixture() });
    const executors = { ...base.executors, mock, forRecipe: (recipe: Parameters<typeof base.executors.forRecipe>[0]) => (recipe.kind === "mock" ? mock : base.executors.forRecipe(recipe)) };
    const tools: ToolContext = { store, now, newId: randomUUID, generation: { ...base, executors } };
    const project = seedProject(store, now);

    const script = await ok<{ script: { id: string } }>(tools, "save_script", { projectId: project.id, title: "Cup holder", beats: CUTAWAY_BEATS });
    const planned = await ok<{ id: string }>(tools, "plan_shots", { projectId: project.id, scriptId: script.script.id });
    for (let beatIndex = 1; beatIndex <= CUTAWAY_BEATS.length; beatIndex++) {
      const [still] = await submit(tools, await ok<GenerationProposal>(tools, "compose_still", { contentId: planned.id, beatIndex, count: 1 }));
      await ok(tools, "approve", { kind: "still", contentId: planned.id, beatIndex, assetId: still });
    }
    // The b-roll beats' clips: solid colors, so a frame shows which source is on screen.
    const broll: Record<number, Asset> = {
      2: await importClip(store, project.id, { color: "0x2fa14a", width: 720, height: 1280, rate: 30, seconds: 3, audio: true }, now()),
      4: await importClip(store, project.id, { color: "0xd2782d", width: 720, height: 1280, rate: 24, seconds: 2, audio: false }, now()),
    };
    for (const [beatIndex, clip] of Object.entries(broll)) {
      const content = store.content.getRequired(planned.id);
      store.content.update(addCandidates(content, Number(beatIndex), "clip", [clip.id], now()));
      await ok(tools, "approve", { kind: "clip", contentId: planned.id, beatIndex: Number(beatIndex), assetId: clip.id });
    }

    // 1. The full talking take, from the first talking beat's still, every line in order.
    const takeProposal = await ok<GenerationProposal>(tools, "generate_take", { contentId: planned.id, recipeId: "mock-image-to-video" });
    assert.equal(takeProposal.spec?.kind, "take");
    assert.equal(takeProposal.durationSeconds, TAKE_SECONDS);
    assert.deepEqual(takeProposal.target, { kind: "take", contentId: planned.id, slot: "clip" });
    for (const beat of CUTAWAY_BEATS) assert.ok(takeProposal.prompt.includes(beat.spokenLine!.replace(/\.$/, "")), beat.spokenLine!);
    const [takeId] = await submit(tools, takeProposal);
    const take = store.assets.getRequired(takeId);
    assert.equal(take.kind, "video");
    assert.equal(take.video?.hasAudio, true, "the mock take is a real MP4 with sound");
    assert.ok(Math.abs(take.video!.durationSeconds - TAKE_SECONDS) < 0.05);
    await ok(tools, "approve", { kind: "take", contentId: planned.id, assetId: takeId });

    // 2. Transcription with word timestamps (the fixture), through the gate like any generation.
    const transcribe = await ok<GenerationProposal>(tools, "transcribe_take", { contentId: planned.id });
    assert.equal(transcribe.capability, "speech_to_text");
    assert.equal(transcribe.recipeId, "mock-speech-to-text", "both Whisper recipes are planned, so the mock runs");
    assert.deepEqual(transcribe.references, [{ role: "take", assetId: takeId }]);
    const [transcriptId] = await submit(tools, transcribe);
    const transcript = store.assets.getRequired(transcriptId);
    assert.equal(transcript.kind, "transcript");
    assert.deepEqual(transcript.transcription, { durationSeconds: 8, wordCount: 17, language: "en" });

    // 3 and 4. Align the beats and write the EDL into the artifact panel.
    const drafted = await ok<{ edl: Edl; version: number; unplaced: number[] }>(tools, "save_edl", { contentId: planned.id });
    assert.equal(drafted.version, 1);
    assert.deepEqual(drafted.unplaced, []);
    assert.deepEqual(drafted.edl.windows, [{ beatIndex: 2, start: 2.2, end: 4.3 }, { beatIndex: 4, start: 6.4, end: 8 }]);
    assert.equal(drafted.edl.transcriptAssetId, transcriptId);
    const jobsBefore = store.jobs.listByProject(project.id).map((job) => job.id).sort();

    // 5. Export: the take's sound untouched, b-roll in the windows, captions at the EDL's times.
    const first = await ok<{ export: ExportRecord; asset: Asset | null }>(tools, "assemble_ad", { contentId: planned.id, strategy: "take_cutaways", exportId: randomUUID() });
    assert.equal(first.export.status, "completed", first.export.status === "failed" ? first.export.error : "");
    assert.equal(first.export.strategy, "take_cutaways");
    assert.equal(first.export.edlVersion, 1);

    // The edit: beat 2's window two seconds later, saved as version 2, then the same export again.
    const moved = shiftWindow(drafted.edl, 2, 2);
    const edited = await ok<{ edl: Edl; version: number }>(tools, "save_edl", { contentId: planned.id, windows: moved.windows });
    assert.equal(edited.version, 2);
    assert.deepEqual(edited.edl.windows[0], { beatIndex: 2, start: 4.2, end: 6.3 });
    const second = await ok<{ export: ExportRecord; asset: Asset | null }>(tools, "assemble_ad", { contentId: planned.id, strategy: "take_cutaways", exportId: randomUUID() });
    assert.equal(second.export.status, "completed", second.export.status === "failed" ? second.export.error : "");
    assert.equal(second.export.edlVersion, 2);

    assert.deepEqual(store.jobs.listByProject(project.id).map((job) => job.id).sort(), jobsBefore, "no generation job was created by the edit or the exports");
    assert.equal(first.export.status === "completed" && second.export.status === "completed" && first.export.filterSummary.includes("stream copied"), true);
    assert.deepEqual(second.export.take, first.export.take, "both exports cut the same take");

    const takePath = resolveMediaPath(store.dataDir, take.relativePath);
    const firstPath = resolveMediaPath(store.dataDir, first.asset!.relativePath);
    const secondPath = resolveMediaPath(store.dataDir, second.asset!.relativePath);
    for (const asset of [first.asset!, second.asset!]) {
      assert.equal(asset.width, 1080);
      assert.equal(asset.height, 1920);
      assert.equal(asset.video?.frameCount, TAKE_SECONDS * 24);
      assert.equal(asset.video?.hasAudio, true);
    }

    // The take's sound, bit for bit: the same AAC packets and the same decoded samples in both.
    const [takeAudio, firstAudio, secondAudio] = await Promise.all([audioOf(takePath), audioOf(firstPath), audioOf(secondPath)]);
    assert.equal(firstAudio.packets, takeAudio.packets, "export 1 carries the take's AAC packets unchanged");
    assert.equal(secondAudio.packets, takeAudio.packets, "export 2 carries the take's AAC packets unchanged");
    assert.equal(firstAudio.pcm, takeAudio.pcm);
    assert.equal(secondAudio.pcm, firstAudio.pcm, "decoded PCM is identical in both exports");
    assert.ok(takeAudio.samples > 48_000 * 7, "about eight seconds of sound");

    // The window moved: 3.0 s is inside the old window only, 4.25 s inside both, 5.5 s inside the new one only.
    const takeColor = meanColor(await frameAt(takePath, 1, { x: 100, y: 100, width: 400, height: 400 }));
    const brollColor = meanColor(await frameAt(resolveMediaPath(store.dataDir, broll[2].relativePath), 0.5, { x: 100, y: 100, width: 400, height: 400 }));
    const ctaColor = meanColor(await frameAt(resolveMediaPath(store.dataDir, broll[4].relativePath), 0.5, { x: 100, y: 100, width: 400, height: 400 }));
    assert.ok(!near(takeColor, brollColor, 40), "the take and the b-roll are told apart by color");
    const expectations: [number, [number, number, number], [number, number, number]][] = [
      [1.0, takeColor, takeColor],
      [3.0, brollColor, takeColor],
      [4.25, brollColor, brollColor],
      [5.5, takeColor, brollColor],
      [6.36, takeColor, takeColor],
      [7.5, ctaColor, ctaColor],
    ];
    for (const [seconds, inFirst, inSecond] of expectations) {
      const a = meanColor(await frameAt(firstPath, seconds, TOP));
      const b = meanColor(await frameAt(secondPath, seconds, TOP));
      assert.ok(near(a, inFirst), `export 1 at ${seconds} s: ${a.map(Math.round)} should be ${inFirst.map(Math.round)}`);
      assert.ok(near(b, inSecond), `export 2 at ${seconds} s: ${b.map(Math.round)} should be ${inSecond.map(Math.round)}`);
    }

    // Captions follow the transcript: none before the first word (0.3 s) or after the last cue (6.4 s).
    for (const path of [firstPath, secondPath]) {
      assert.equal(await captionPixels(path, 0.1), 0, "no caption before the first word");
      assert.ok((await captionPixels(path, 1.0)) > 500, "beat 1's caption from its first word");
      assert.ok((await captionPixels(path, 3.0)) > 500, "beat 2's caption, over the take or the b-roll alike");
      assert.ok((await captionPixels(path, 5.0)) > 500, "beat 3's caption");
      assert.equal(await captionPixels(path, 7.5), 0, "beat 4 has no on-screen text");
    }
    const beatTwo = await frameAt(secondPath, 2.6, BAND);
    const beatThree = await frameAt(secondPath, 4.5, BAND);
    assert.notDeepEqual(beatTwo, beatThree, "the caption changes at 4.3 s, where beat 3's first word starts");

    // The panel's history holds both versions; the content piece reads the edited one.
    const history = await ok<{ current: number; versions: { version: number }[] }>(tools, "list_document_versions", { kind: "edl", subjectId: planned.id });
    assert.equal(history.current, 2);
    assert.deepEqual(history.versions.map((version) => version.version), [1, 2]);
    const restored = await ok<{ document: { version: number } }>(tools, "restore_document_version", { kind: "edl", subjectId: planned.id, version: 1 });
    assert.equal(restored.document.version, 3);
    assert.deepEqual((store.content.getRequired(planned.id) as ContentPiece).edl?.windows[0], { beatIndex: 2, start: 2.2, end: 4.3 });
  });

  test("the plan cuts the take around each window and copies AAC audio", () => {
    const plan = planCutaways(
      { path: "take.mp4", frames: 192, width: 720, height: 1280, audio: "copy" },
      [
        { beatIndex: 4, source: "still", path: "b.png", width: 90, height: 160, startFrame: 154, endFrame: 192 },
        { beatIndex: 2, source: "video", path: "a.mp4", width: 720, height: 1280, startFrame: 53, endFrame: 103 },
      ],
      [{ start: 0.3, end: 2.2, text: "Fits the cup holder." }],
      { fontPath: "/fonts/caption.ttf", output: "out.mp4" },
    );
    assert.deepEqual(plan.parts.map((part) => [part.kind, part.startFrame, part.endFrame]), [
      ["take", 0, 53],
      ["window", 53, 103],
      ["take", 103, 154],
      ["window", 154, 192],
    ]);
    assert.ok(plan.filterGraph.includes("split=2[t0][t1]"));
    assert.ok(plan.filterGraph.includes("[t1]trim=start_frame=103:end_frame=154"));
    assert.ok(plan.filterGraph.includes("concat=n=4:v=1:a=0[joined]"));
    assert.ok(plan.filterGraph.includes("enable='between(t,0.300,2.200)'"));
    const audio = plan.args.indexOf("0:a:0");
    assert.deepEqual(plan.args.slice(audio - 1, audio + 3), ["-map", "0:a:0", "-c:a", "copy"]);
    assert.ok(!plan.args.slice(plan.args.indexOf("-filter_complex")).includes("-t"), "the output is never cut short, so the take's sound stays whole");
    assert.equal(plan.args.indexOf("a.mp4") < plan.args.indexOf("b.png"), true, "window inputs follow in time order");
    const muted = planCutaways({ path: "take.mp4", frames: 48, audio: "none" }, [], [], { output: "out.mp4" });
    assert.ok(muted.args.includes("-an"));
    assert.ok(muted.filterGraph.includes("[p0]null[joined]"));
  });

  test("the mock take colour is the one the frame checks compare against", () => {
    assert.match(MOCK_TAKE_COLOR, /^0x[0-9a-f]{6}$/);
  });
});
