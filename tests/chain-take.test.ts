/**
 * Chained takes end to end (v0.2 F4) through the real tools, store, run orchestration, and ffmpeg,
 * on a mock executor that makes real MP4 segments. The acceptance case: a 20 s talking take on a
 * 5 s model completes as four chained segments with one continuous audio track and no cut in the
 * voice (checked with ffprobe and silencedetect around every seam). Also: a restart in the middle
 * resumes without resubmitting, an uncertain segment past the collection window ends the take and
 * releases its hold, and the whole take is reserved up front (a take that does not fit starts
 * nothing; a held take blocks other spending; a lowered ceiling pauses it, resubmitting resumes it).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import type { Recipe } from "@creator-lab/core/catalog";
import { advanceJob, type GenerationProposal, type Job } from "@creator-lab/core/domain/job";
import type { Executor, ExecutorSet, PollOutcome, SubmitOutcome } from "@creator-lab/executors";
import { MockExecutor } from "@creator-lab/executors";
import { ffmpegPath, ffprobePath } from "@creator-lab/executors/media";
import { renderMockWav } from "@creator-lab/executors/mock";
import { currentSpendPolicy, COLLECTION_WINDOW_MS } from "@creator-lab/executors/spend";
import { MOCK_RECIPES } from "@creator-lab/recipes/defaults";
import { recoverChains } from "@/server/generation/chain";
import { recoverAndDrain } from "@/server/generation/run";
import { importAudio } from "@/server/media/audio";
import { resolveMediaPath } from "@/server/media/paths";
import { type Store, openStore } from "@/server/store";
import { callTool } from "@/server/tools";
import { runDeps } from "@/server/tools/proposals";
import type { GenerationContext, ToolContext } from "@/server/tools/registry";
import { averyBible, seedProject, tempDir } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** About 40 words, a 16 s read at 2.5 words per second: one talking beat's line for a 20 s take. */
const LONG_LINE =
  "I stopped buying bottled water the day this fit my cup holder. It rides with me all week, it stays cold through a long commute, and I never think about it. Honestly, that is the whole point for me.";

/** Sixteen words: enough for a take of two to four segments at an easy pace. */
const SHORT_LINE = "It fits my cup holder, it stays cold all day, and I never think about it.";

const BEAT = {
  type: "talking",
  purpose: "hook",
  spokenLine: LONG_LINE,
  onScreenText: "Fits the cup holder.",
  visual: "Avery in the driver's seat holding the Ridgeline bottle, morning light.",
  setting: "a car interior",
  productVisible: true,
  durationSeconds: 15,
} as const;

interface Harness {
  dir: string;
  store: Store;
  tools: ToolContext;
  clock: { now: number };
  /** Request ids whose poll answers "still running" (to stop a chain mid-way). */
  holdPoll: Set<string>;
  /** Request ids whose submission is left uncertain. */
  uncertain: Set<string>;
  submits: string[];
  ceiling: { usd: number };
  close(): void;
}

/** A mock that can hold a job at "running" or leave its submission uncertain, around a real mp4 mock. */
function gatedExecutor(store: Store, inner: MockExecutor, harness: Pick<Harness, "holdPoll" | "uncertain" | "submits" | "clock">): Executor {
  return {
    kind: "mock",
    estimate: (request) => inner.estimate(request),
    submit: async (job: Job): Promise<SubmitOutcome> => {
      harness.submits.push(job.requestId);
      if (harness.uncertain.has(job.requestId)) {
        const current = store.jobs.getRequired(job.id);
        const next = advanceJob(current, { status: "uncertain", notice: "The submission timed out after it was sent." }, harness.clock.now);
        store.jobs.transition(current, next);
        return { kind: "uncertain", job: next };
      }
      return inner.submit(job);
    },
    poll: async (jobId: string): Promise<PollOutcome> => {
      const job = store.jobs.getRequired(jobId);
      if (job.status === "uncertain") return { kind: "uncertain", job, retryAfterMs: 60_000 };
      if (harness.holdPoll.has(job.requestId)) return { kind: "pending", job, retryAfterMs: 1000, queuePosition: null };
      return inner.poll(jobId);
    },
    retrieve: (jobId, destination) => inner.retrieve(jobId, destination),
  };
}

function open(dir: string, shared?: Partial<Pick<Harness, "holdPoll" | "uncertain" | "submits" | "clock" | "ceiling">>): Harness {
  const store = openStore(dir);
  const clock = shared?.clock ?? { now: Date.UTC(2026, 10, 10, 12) };
  const harness = {
    dir,
    store,
    clock,
    holdPoll: shared?.holdPoll ?? new Set<string>(),
    uncertain: shared?.uncertain ?? new Set<string>(),
    submits: shared?.submits ?? [],
    ceiling: shared?.ceiling ?? { usd: 0 },
  } as Harness;
  const now = () => (clock.now += 1000);
  // One simulated dollar per video segment, nothing for stills and voices: the spend gate runs for real.
  const mock = new MockExecutor({ jobs: store.jobs, video: "mp4", now, price: (input) => (harness.ceiling.usd > 0 && input.durationSeconds && input.images.length ? 1 : undefined) });
  const gate = gatedExecutor(store, mock, harness);
  const executors: ExecutorSet = { mock, forRecipe: () => gate };
  const generation: GenerationContext = {
    executors,
    recipes: async () => MOCK_RECIPES as Recipe[],
    operatorCeilingUsd: () => harness.ceiling.usd,
    // Never wakes: a chain that has to wait stops there, as if the process ended.
    sleep: () => new Promise(() => undefined),
  };
  harness.tools = { store, now, newId: randomUUID, generation };
  harness.close = () => {
    try {
      store.close();
    } catch {
      // Already closed.
    }
  };
  return harness;
}

function setup(): Harness {
  const dir = tempDir();
  const harness = open(dir);
  cleanups.push(() => {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return harness;
}

async function ok<T>(tools: ToolContext, name: string, input: unknown): Promise<T> {
  const result = await callTool(tools, name, input);
  if (!result.ok) assert.fail(`${name} failed: ${result.failure.code} ${result.failure.message}`);
  return result.output as T;
}

type Submitted = { results: { outcome: string; assetIds: string[]; message: string | null; reserveUsd: number | null; budget: unknown }[] };

/** A project with Avery linked, a one-beat talking script, an approved still and, optionally, an approved voice take. */
async function talkingBeat(harness: Harness, options: { voice?: boolean; line?: string } = {}) {
  const { tools, store } = harness;
  const project = seedProject(store, tools.now);
  const saved = await ok<{ character: { id: string } }>(tools, "save_character_bible", { projectId: project.id, wardrobe: "Olive utility jacket over a white tee", bible: averyBible() });
  const script = await ok<{ script: { id: string } }>(tools, "save_script", { projectId: project.id, title: "Long take", beats: [{ ...BEAT, spokenLine: options.line ?? LONG_LINE }] });
  const content = await ok<{ id: string }>(tools, "plan_shots", { projectId: project.id, scriptId: script.script.id });
  const still = await ok<GenerationProposal>(tools, "compose_still", { contentId: content.id, beatIndex: 1, count: 1 });
  const stills = await ok<Submitted>(tools, "submit_proposal", { proposal: still, wait: true });
  await ok(tools, "approve", { kind: "still", contentId: content.id, beatIndex: 1, assetId: stills.results[0].assetIds[0] });
  if (options.voice) {
    const recording = await importAudio(store, { projectId: project.id, name: "creator-voice.wav", bytes: renderMockWav("Hello, this is the creator's voice sample for the ad.").bytes }, { now: tools.now(), newId: randomUUID });
    await ok(tools, "select_reference", { characterId: saved.character.id, slot: "voice", assetId: recording.id, archiveSiblings: false });
    const voice = await ok<GenerationProposal>(tools, "generate_voice_over", { projectId: project.id, contentId: content.id, beatIndex: 1, recipeId: "mock-text-to-speech" });
    const takes = await ok<Submitted>(tools, "submit_proposal", { proposal: voice, wait: true });
    await ok(tools, "approve", { kind: "voice", contentId: content.id, beatIndex: 1, assetId: takes.results[0].assetIds[0] });
  }
  return { projectId: project.id, characterId: saved.character.id, contentId: content.id };
}

function probe(path: string): { streams: { codec_type: string }[]; format: { duration: string } } {
  const run = spawnSync(ffprobePath(), ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

/** Every silence of 50 ms or more below -50 dBFS, as [start, end]. */
function silences(path: string): [number, number][] {
  const run = spawnSync(ffmpegPath(), ["-nostdin", "-hide_banner", "-nostats", "-i", path, "-vn", "-af", "silencedetect=n=-50dB:d=0.05", "-f", "null", "-"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const starts = [...run.stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...run.stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  return starts.map((start, index) => [start, ends[index] ?? Number(probe(path).format.duration)]);
}

/** The quietest 25 ms window within a quarter second of a moment, from astats. */
function quietestNear(path: string, seconds: number): number {
  const run = spawnSync(
    ffmpegPath(),
    ["-nostdin", "-hide_banner", "-nostats", "-ss", (seconds - 0.25).toFixed(3), "-t", "0.5", "-i", path, "-vn", "-af", "asetnsamples=n=1200:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const levels = [...run.stderr.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((match) => (match[1] === "-inf" ? -Infinity : Number(match[1])));
  assert.ok(levels.length > 0, "astats read the window");
  return Math.min(...levels);
}

describe("a chained talking take on the mock", () => {
  test("acceptance: a 20 s talking take on a 5 s model is four chained segments, one audio track, no cut in the voice", async (t) => {
    const harness = setup();
    const { tools, store } = harness;
    const { contentId } = await talkingBeat(harness, { voice: true });
    const proposal = await ok<GenerationProposal>(tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video", durationSeconds: 20 });
    assert.equal(proposal.durationSeconds, 20);
    assert.equal(proposal.spec?.kind === "clip" && proposal.spec.durationSeconds, 15, "the spec keeps one run's length; the take is on the proposal");
    assert.match(proposal.estimate.note, /Chained take: 4 segments of 5\.00 s/);
    assert.match(proposal.estimate.note, /approved voice take as the one audio track/);
    assert.equal((proposal.prompt.match(/\[Segment \d of 4/g) ?? []).length, 4, "the card shows every segment's prompt");

    const submitted = await ok<Submitted>(tools, "submit_proposal", { proposal, wait: true });
    assert.equal(submitted.results.length, 1);
    assert.equal(submitted.results[0].outcome, "completed", submitted.results[0].message ?? "");
    const [takeId] = submitted.results[0].assetIds;
    const chain = store.chains.listByProject(proposal.projectId)[0];
    assert.equal(chain.status, "completed");
    assert.equal(chain.segments.length, 4, "four chained segments");
    assert.equal(chain.outputAssetId, takeId);

    // Each segment is its own durable job, segments 2 to 4 started from the previous handover frame.
    const jobs = chain.segments.map((segment) => store.jobs.getRequired(segment.jobId!));
    assert.ok(jobs.every((job) => job.status === "completed" && job.capability === "image_to_video"));
    assert.equal(new Set(jobs.map((job) => job.id)).size, 4);
    for (const [position, job] of jobs.entries()) {
      if (position === 0) assert.equal(job.request.inputs[0].role, "image1", "segment 1 starts from the approved still");
      else assert.equal(job.request.input.images[0], chain.segments[position].startFrame!.relativePath, `segment ${position + 1} starts from the handover frame`);
    }
    assert.match(jobs[0].request.input.prompt, /glances back to the lens mid-thought/, "the outgoing segment foreshadows the next one");
    assert.match(jobs[1].request.input.prompt, /^Use the provided start image as the first frame; it is the last moment of the previous shot/);
    assert.doesNotMatch(jobs[3].request.input.prompt, /ready to go on/, "the last segment sets nothing up");
    assert.equal(chain.segments.map((segment) => segment.line).join(" "), LONG_LINE, "the line is shared out across the segments, word for word");

    // The take is the shot's one new clip candidate; the segments went to the Archive.
    const shot = store.content.getRequired(contentId).shots[0];
    assert.equal(shot.clip.state, "open");
    assert.deepEqual(shot.clip.state === "open" ? shot.clip.candidateIds : [], [takeId]);
    for (const segment of chain.segments) assert.equal(store.assets.getRequired(segment.assetId!).state.state, "archived");
    const take = store.assets.getRequired(takeId);
    assert.equal(take.kind, "video");
    assert.ok(take.provenance.source === "generated" && take.provenance.mock && take.provenance.jobId === jobs[0].id);

    // ffprobe: about 20 s, one audio stream; no gap or discontinuity around any seam.
    const path = resolveMediaPath(store.dataDir, take.relativePath);
    const info = probe(path);
    const duration = Number(info.format.duration);
    assert.ok(Math.abs(duration - 20) <= 0.35, `about 20 s (${duration})`);
    assert.equal(info.streams.filter((stream) => stream.codec_type === "audio").length, 1, "a single audio stream");
    assert.equal(info.streams.filter((stream) => stream.codec_type === "video").length, 1);
    assert.equal(chain.seams.length, 3);
    const quiet = silences(path);
    const voice = store.assets.getRequired(chain.spine!.assetId);
    for (const seam of chain.seams) {
      assert.deepEqual(seam.issues, [], `seam at ${seam.seconds} s is clean: ${JSON.stringify(seam)}`);
      assert.ok(seam.seconds < voice.audio!.durationSeconds, "every seam falls inside the voice");
      assert.ok(!quiet.some(([start, end]) => start < seam.seconds + 0.25 && end > seam.seconds - 0.25), `no silence within 0.25 s of ${seam.seconds} s`);
      assert.ok(quietestNear(path, seam.seconds) > -50, `the voice carries through ${seam.seconds} s`);
    }
    t.diagnostic(
      `ffprobe: duration ${info.format.duration} s, streams ${info.streams.map((stream) => stream.codec_type).join("+")}; seams ${chain.seams.map((seam) => `${seam.seconds}s (quietest ${seam.quietestDb} dBFS, click ratio ${seam.clickRatio}, YDIF ${seam.videoDifference}/${seam.videoBaseline})`).join(", ")}; silences ${JSON.stringify(quiet)}; voice take ${voice.audio!.durationSeconds} s`,
    );

    // Submitting the same proposal again never runs it twice.
    const again = await ok<Submitted>(tools, "submit_proposal", { proposal, wait: true });
    assert.equal(again.results[0].outcome, "completed");
    assert.deepEqual(again.results[0].assetIds, [takeId]);
    assert.equal(store.jobs.listByProject(proposal.projectId).filter((job) => job.capability === "image_to_video").length, 4);

    // "Regenerate with..." on the take proposes the whole take again, not one segment.
    const redo = await ok<GenerationProposal>(tools, "regenerate_with", { assetId: takeId, recipeId: "mock-image-to-video" });
    assert.equal(redo.durationSeconds, chain.totalSeconds);
    assert.match(redo.estimate.note, /Chained take: 4 segments/);
  });

  test("a take the recipe makes in one run stays a single job", async () => {
    const harness = setup();
    const { contentId } = await talkingBeat(harness);
    const proposal = await ok<GenerationProposal>(harness.tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video", durationSeconds: 5 });
    assert.doesNotMatch(proposal.estimate.note, /Chained/);
    assert.doesNotMatch(proposal.prompt, /\[Segment/);
    const submitted = await ok<Submitted>(harness.tools, "submit_proposal", { proposal, wait: true });
    assert.equal(submitted.results[0].outcome, "completed");
    assert.equal(harness.store.chains.listByProject(proposal.projectId).length, 0);
  });

  test("an edited prompt is refused for a chained take, and so is a take that would cut the voice", async () => {
    const harness = setup();
    const { contentId } = await talkingBeat(harness, { voice: true });
    const proposal = await ok<GenerationProposal>(harness.tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video", durationSeconds: 20 });
    const edited = await callTool(harness.tools, "submit_proposal", { proposal: { ...proposal, prompt: "Something else.", promptEdited: true }, wait: true });
    assert.ok(!edited.ok && /renders one prompt per segment/.test(edited.failure.message), "an edited prompt is refused");
    const short = await callTool(harness.tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video", durationSeconds: 12 });
    assert.ok(!short.ok && /would cut it/.test(short.failure.message), "a take shorter than its voice take is refused");
    const defaulted = await ok<GenerationProposal>(harness.tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video" });
    assert.equal(defaulted.durationSeconds, 16, "with no length given, the take runs as long as its voice take (15.6 s) plus a breath");
  });

  test("a restart in the middle resumes the chain without resubmitting a segment", async () => {
    const harness = setup();
    const { tools, store } = harness;
    const { contentId } = await talkingBeat(harness, { line: SHORT_LINE });
    const proposal = await ok<GenerationProposal>(tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video", durationSeconds: 10 });
    // Hold segment 2 at "running" once it is submitted, then stop the process there.
    const plannedSecond = () => store.chains.listByProject(proposal.projectId)[0]?.segments[1].requestId;
    const original = harness.holdPoll.has.bind(harness.holdPoll);
    harness.holdPoll.has = (requestId: string) => requestId === plannedSecond() || original(requestId);
    const submitted = await ok<Submitted>(tools, "submit_proposal", { proposal });
    assert.equal(submitted.results[0].outcome, "started");
    for (let tries = 0; tries < 100 && harness.submits.filter((id) => id === plannedSecond()).length === 0; tries++) await new Promise((wait) => setTimeout(wait, 50));
    const before = store.chains.listByProject(proposal.projectId)[0];
    assert.equal(before.status, "running");
    assert.ok(before.segments[0].assetId && before.segments[1].jobId && !before.segments[1].assetId, "segment 1 made, segment 2 in flight");
    const submitsBefore = [...harness.submits];
    harness.close();

    const reopened = open(harness.dir, { clock: harness.clock, submits: harness.submits, ceiling: harness.ceiling });
    cleanups.push(() => reopened.close());
    const deps = runDeps(reopened.tools);
    await recoverAndDrain(deps);
    const [step] = await recoverChains(deps);
    assert.equal(step.kind, "completed");
    const after = reopened.store.chains.getRequired(before.id);
    assert.equal(after.segments[1].jobId, before.segments[1].jobId, "the same segment job carried on");
    assert.deepEqual(reopened.submits.slice(0, submitsBefore.length), submitsBefore);
    assert.equal(reopened.submits.filter((id) => id === before.segments[0].requestId).length, 1, "segment 1 was submitted once");
    assert.equal(reopened.submits.filter((id) => id === before.segments[1].requestId).length, 1, "segment 2 was submitted once");
    assert.ok(after.outputAssetId && reopened.store.assets.getRequired(after.outputAssetId).kind === "video");
  });
});

describe("a chained take and the budget", () => {
  async function priced(budget: number) {
    const harness = setup();
    harness.ceiling.usd = 50;
    harness.store.workspace.update({ monthlyBudgetUsd: budget }, harness.clock.now);
    return { harness, ...(await talkingBeat(harness, { line: SHORT_LINE })) };
  }

  test("the whole take must fit before segment 1 runs: a take that does not fit starts nothing", async () => {
    const { harness, contentId } = await priced(3.5);
    const proposal = await ok<GenerationProposal>(harness.tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video", durationSeconds: 20 });
    assert.equal(proposal.estimate.usd, 4, "four segments at $1 each");
    const submitted = await ok<Submitted>(harness.tools, "submit_proposal", { proposal, wait: true });
    assert.equal(submitted.results[0].outcome, "blocked");
    assert.match(submitted.results[0].message!, /whole take is reserved before segment 1 runs/);
    assert.ok(submitted.results[0].budget, "the extend dialog gets the crossing");
    assert.equal(harness.store.chains.listByProject(proposal.projectId).length, 0);
    assert.equal(harness.store.jobs.listByProject(proposal.projectId).filter((job) => job.capability === "image_to_video").length, 0);
  });

  test("an admitted take holds every segment, so other spending cannot strand it; a lowered ceiling pauses it and a resubmit resumes it", async () => {
    const { harness, contentId } = await priced(10);
    const { tools, store } = harness;
    const proposal = await ok<GenerationProposal>(tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video", durationSeconds: 20 });
    const firstSegment = () => store.chains.listByProject(proposal.projectId)[0]?.segments[0].requestId;
    harness.holdPoll.has = (requestId: string) => requestId === firstSegment();
    const started = await ok<Submitted>(tools, "submit_proposal", { proposal });
    assert.equal(started.results[0].outcome, "started");
    assert.equal(started.results[0].reserveUsd, 4);
    const deps = runDeps(tools);
    const held = currentSpendPolicy(deps);
    assert.equal(held.reservedUsd, 4, "segment 1's job reserves $1 and the three segments not admitted yet hold $3");

    // Three more 12 s takes ($9) would fit the $10 budget on their own, but not beside the held take.
    const other = await ok<GenerationProposal>(tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video", durationSeconds: 12, count: 3 });
    assert.equal(other.estimate.usd, 3);
    const blocked = await ok<Submitted>(tools, "submit_proposal", { proposal: other, wait: true });
    assert.equal(blocked.results.at(-1)!.outcome, "blocked");
    assert.equal(store.chains.listByProject(proposal.projectId).length, 1, "none of the other takes started");

    // The operator lowers the ceiling to $2 while segment 1 runs: segment 2 cannot be admitted.
    harness.ceiling.usd = 2;
    harness.holdPoll.has = () => false;
    const chainId = store.chains.listByProject(proposal.projectId)[0].id;
    const { advanceChain } = await import("@/server/generation/chain");
    const paused = await advanceChain(deps, chainId);
    assert.equal(paused.kind, "paused");
    assert.match(paused.chain.notice!, /Paused before segment 2 of 4 \(1 made and kept\)/);
    assert.equal(currentSpendPolicy(deps).reservedUsd, 0, "a paused take holds nothing; segment 1 settled");
    assert.equal(currentSpendPolicy(deps).spentUsd, 1);

    // Raised again, the same proposal resumes the take: the rest is checked as a whole and finished.
    harness.ceiling.usd = 50;
    const resumed = await ok<Submitted>(tools, "submit_proposal", { proposal, wait: true });
    assert.equal(resumed.results[0].outcome, "completed", resumed.results[0].message ?? "");
    const done = store.chains.getRequired(chainId);
    assert.equal(done.status, "completed");
    assert.equal(currentSpendPolicy(deps).spentUsd, 4, "four segments, each paid once");
    assert.equal(currentSpendPolicy(deps).reservedUsd, 0);
  });

  test("a segment left uncertain past the collection window ends the take and releases what it held", async () => {
    const { harness, contentId } = await priced(10);
    const { tools, store } = harness;
    const proposal = await ok<GenerationProposal>(tools, "generate_clip", { contentId, beatIndex: 1, recipeId: "mock-image-to-video", durationSeconds: 15 });
    const third = () => store.chains.listByProject(proposal.projectId)[0]?.segments[2]?.requestId;
    harness.uncertain.has = (requestId: string) => requestId === third();
    const submitted = await ok<Submitted>(tools, "submit_proposal", { proposal });
    assert.equal(submitted.results[0].outcome, "started");
    // The chain waits on the uncertain segment (the test's sleep never wakes), holding its money.
    for (let tries = 0; tries < 100 && !harness.submits.includes(third() ?? ""); tries++) await new Promise((wait) => setTimeout(wait, 50));
    const deps = runDeps(tools);
    assert.equal(currentSpendPolicy(deps).reservedUsd, 1, "the uncertain segment keeps its reservation while it may still run");
    harness.clock.now += COLLECTION_WINDOW_MS + 60_000;
    const [step] = await recoverChains({ ...deps, sleep: async () => undefined });
    assert.equal(step.kind, "failed");
    assert.match(step.chain.notice!, /Segment 3 of 3 could not be confirmed within 23 hours/);
    const policy = currentSpendPolicy(deps);
    assert.equal(policy.reservedUsd, 0, "nothing stays held");
    assert.equal(policy.spentUsd, 2, "the two segments that ran are spent");
  });
});
