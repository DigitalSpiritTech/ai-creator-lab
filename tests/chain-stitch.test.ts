/**
 * The local half of a chained take with real ffmpeg: mock segments made from each other's handover
 * frames, the stitch (video crossfade plus either the segments' crossfaded audio or the voice take
 * as the spine), and the seam check, which must pass on a clean chain and catch black frames, a
 * jump, an audio gap, and a click.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import sharp from "sharp";
import { planChain } from "@creator-lab/core/catalog";
import { type Job, JobRequestSchema } from "@creator-lab/core/domain/job";
import { ffmpegPath, ffprobePath, probeVideo } from "@creator-lab/executors/media";
import { MOCK_RECIPES } from "@creator-lab/recipes/defaults";
import { renderMockMp4, renderMockWav } from "@creator-lab/executors/mock";
import { checkSeams, crossfadeOffsets, extractHandoverFrame, sliceAudio, stitchFilter, stitchTake } from "@creator-lab/executors/stitch";

const root = mkdtempSync(join(tmpdir(), "chain-stitch-"));

/** A plan the test expects to exist. */
function planned(...args: Parameters<typeof planChain>): NonNullable<ReturnType<typeof planChain>> {
  const plan = planChain(...args);
  assert.ok(plan, `a plan for ${args[0]} s on ${args[1]} s segments`);
  return plan;
}
after(() => rmSync(root, { recursive: true, force: true }));

const i2v = MOCK_RECIPES.find((recipe) => recipe.capability === "image_to_video")!;
const s2v = MOCK_RECIPES.find((recipe) => recipe.capability === "speech_to_video")!;

function mockJob(recipe: typeof i2v, input: { images?: string[]; durationSeconds: number; audio?: string }): Pick<Job, "capability" | "request"> {
  return { capability: recipe.capability, request: JobRequestSchema.parse({ recipe, input: { prompt: "mock segment", aspectRatio: "9:16", ...input } }) };
}

/** A still with edges everywhere, so the scrolling picture changes visibly from frame to frame. */
async function still(name: string, color = "#2a4d6e"): Promise<string> {
  const path = join(root, name);
  const stripes = Array.from({ length: 24 }, (_, index) => `<rect x="${index * 30}" y="0" width="12" height="1280" fill="#f4c888" opacity="${0.2 + (index % 4) * 0.2}"/>`).join("");
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="${color}"/>${stripes}<circle cx="360" cy="500" r="160" fill="#f2cf96"/></svg>`))
    .png()
    .toFile(path);
  return path;
}

/** Makes a chain the way the app does: each segment after the first starts from the previous one's handover frame. */
async function chainOf(plan: NonNullable<ReturnType<typeof planChain>>, first: string, prefix: string, audio?: (index: number) => string): Promise<{ path: string; durationSeconds: number; hasAudio: boolean }[]> {
  const made: { path: string; durationSeconds: number; hasAudio: boolean }[] = [];
  let image = first;
  for (const segment of plan.segments) {
    const path = join(root, `${prefix}-${segment.index}.mp4`);
    const recipe = audio ? s2v : i2v;
    const file = await renderMockMp4(mockJob(recipe, { images: [image], durationSeconds: segment.durationSeconds, ...(audio ? { audio: audio(segment.index) } : {}) }), path, `media/${prefix}-${segment.index}.mp4`, root);
    made.push({ path, durationSeconds: file.video!.durationSeconds, hasAudio: file.video!.hasAudio });
    image = join(root, `${prefix}-${segment.index}-handover.png`);
    await extractHandoverFrame(path, { frames: file.video!.frames, fps: file.video!.fps }, plan.overlapSeconds, image);
  }
  return made;
}

function probeStreams(path: string): { streams: { codec_type: string; duration?: string }[]; format: { duration: string } } {
  return JSON.parse(execFileSync(ffprobePath(), ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }));
}

/** silencedetect over the whole take: every silence of 50 ms or more below -50 dBFS. */
function silences(path: string): string[] {
  const run = spawnSync(ffmpegPath(), ["-nostdin", "-hide_banner", "-nostats", "-i", path, "-vn", "-af", "silencedetect=n=-50dB:d=0.05", "-f", "null", "-"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stderr.split("\n").filter((line) => line.includes("silence_start"));
}

describe("stitch filter", () => {
  test("crossfade offsets and seams follow the measured segment lengths", () => {
    const { offsets, seams, totalSeconds } = crossfadeOffsets([5, 5, 5, 5], 0.25);
    assert.deepEqual(offsets, [4.75, 9.5, 14.25]);
    assert.deepEqual(seams, [4.875, 9.625, 14.375]);
    assert.equal(totalSeconds, 19.25);
  });

  test("the spine replaces the segments' audio; without one the audio crossfades at every seam", () => {
    const segments = [5, 5, 5].map((durationSeconds, index) => ({ path: `${index}.mp4`, durationSeconds, hasAudio: index !== 1 }));
    const own = stitchFilter({ segments, overlapSeconds: 0.25, width: 720, height: 1280, fps: 24 });
    assert.equal((own.graph.match(/xfade=transition=fade:duration=0\.250/g) ?? []).length, 2);
    assert.equal((own.graph.match(/acrossfade=d=0\.250/g) ?? []).length, 2);
    assert.match(own.graph, /anullsrc=r=48000:cl=stereo,atrim=0:5\.000/, "a segment without audio is filled with silence for its length");
    const spined = stitchFilter({ segments, overlapSeconds: 0.25, width: 720, height: 1280, fps: 24, spine: { path: "voice.wav" } });
    assert.doesNotMatch(spined.graph, /acrossfade/);
    assert.match(spined.graph, /\[3:a\]aresample=48000.*apad,atrim=0:14\.500/);
  });
});

describe("chained mock segments, stitched", () => {
  test("a 20 s take on a 5 s model: four segments, one audio track, clean seams (segment audio crossfaded)", async () => {
    const plan = planned(20, 5);
    assert.equal(plan.segments.length, 4);
    const segments = await chainOf(plan, await still("start.png"), "own");
    const out = join(root, "own-take.mp4");
    const stitched = await stitchTake({ segments, overlapSeconds: plan.overlapSeconds, width: 720, height: 1280, fps: 24, out });
    const probe = probeStreams(out);
    assert.equal(probe.streams.filter((stream) => stream.codec_type === "audio").length, 1, "one audio stream");
    assert.ok(Math.abs(Number(probe.format.duration) - 20) <= 0.35, `about 20 s (${probe.format.duration})`);
    assert.equal(stitched.seams.length, 3);
    const report = await checkSeams(out, stitched.seams, stitched.info.durationSeconds);
    for (const seam of report) assert.deepEqual(seam.issues, [], `seam at ${seam.seconds} s: ${JSON.stringify(seam)}`);
    assert.deepEqual(silences(out), [], "no silence anywhere in the take");
  });

  test("an audio-driven chain follows slices of one voice take, and the take is the one audio track", async () => {
    const voice = join(root, "voice.wav");
    const spoken = Array.from({ length: 48 }, (_, index) => `word${index}`).join(" ");
    const wav = renderMockWav(spoken);
    writeFileSync(voice, wav.bytes);
    const plan = planned(wav.durationSeconds + 0.4, 4.8);
    const slices = plan.segments.map((segment) => join(root, `voice-${segment.index}.wav`));
    for (const [position, segment] of plan.segments.entries()) await sliceAudio(voice, segment.startSeconds, segment.durationSeconds, slices[position]);
    const segments = await chainOf(plan, await still("speech.png", "#3b2a4d"), "spoken", (index) => slices[index - 1]);
    const out = join(root, "spoken-take.mp4");
    const stitched = await stitchTake({ segments, overlapSeconds: plan.overlapSeconds, spine: { path: voice }, width: 720, height: 1280, fps: 24, out });
    const probe = probeStreams(out);
    assert.equal(probe.streams.filter((stream) => stream.codec_type === "audio").length, 1);
    assert.ok(Math.abs(stitched.info.durationSeconds - plan.totalSeconds) < 0.1);
    const report = await checkSeams(out, stitched.seams, stitched.info.durationSeconds);
    for (const seam of report) assert.deepEqual(seam.issues, [], `seam at ${seam.seconds} s: ${JSON.stringify(seam)}`);
  });
});

describe("seam check catches slop", () => {
  test("black frames and a jump between unrelated segments are flagged at the seam", async () => {
    const plan = planned(10, 5);
    const light = await renderMockMp4(mockJob(i2v, { images: [await still("light.png", "#e8e2d0")], durationSeconds: 5 }), join(root, "light.mp4"), "media/light.mp4", root);
    const dark = await renderMockMp4(mockJob(i2v, { images: [await still("dark.png", "#101418")], durationSeconds: 5 }), join(root, "dark.mp4"), "media/dark.mp4", root);
    const jumpy = join(root, "jumpy.mp4");
    const joined = await stitchTake({
      segments: [
        { path: join(root, "light.mp4"), durationSeconds: light.video!.durationSeconds, hasAudio: true },
        { path: join(root, "dark.mp4"), durationSeconds: dark.video!.durationSeconds, hasAudio: true },
      ],
      overlapSeconds: plan.overlapSeconds,
      width: 720,
      height: 1280,
      fps: 24,
      out: jumpy,
    });
    const [jump] = await checkSeams(jumpy, joined.seams, joined.info.durationSeconds);
    assert.ok(jump.issues.includes("jump"), `a jump is flagged: ${JSON.stringify(jump)}`);

    const blackPath = join(root, "black.mp4");
    execFileSync(ffmpegPath(), ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=720x1280:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", blackPath]);
    const blackSeam = join(root, "black-seam.mp4");
    const withBlack = await stitchTake({
      segments: [
        { path: join(root, "light.mp4"), durationSeconds: light.video!.durationSeconds, hasAudio: true },
        { path: blackPath, durationSeconds: (await probeVideo(blackPath)).durationSeconds, hasAudio: true },
      ],
      overlapSeconds: 0.25,
      width: 720,
      height: 1280,
      fps: 24,
      out: blackSeam,
    });
    const [black] = await checkSeams(blackSeam, withBlack.seams, withBlack.info.durationSeconds);
    assert.ok(black.issues.includes("black"), `black frames are flagged: ${JSON.stringify(black)}`);
  });

  test("an audio gap and a click at a seam are flagged", async () => {
    // Two tones butted together with a hard phase jump at 2 s, then 0.3 s of silence at 4 s.
    const path = join(root, "audio-slop.mp4");
    const tone = "0.5*sin(2*PI*220*t)";
    const flipped = "0.5*sin(2*PI*220*t+PI/2)";
    execFileSync(ffmpegPath(), [
      "-nostdin", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=24:duration=6",
      "-f", "lavfi", "-i", `aevalsrc='if(lt(t,2),${tone},if(lt(t,4),${flipped},if(lt(t,4.3),0,${tone})))':s=48000:d=6`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-f", "mov", path,
    ]);
    const [click, gap] = await checkSeams(path, [2, 4.15], 6);
    assert.ok(click.issues.includes("audio_click"), `the phase jump is a click: ${JSON.stringify(click)}`);
    assert.ok(gap.issues.includes("audio_gap"), `the silence is a gap: ${JSON.stringify(gap)}`);
  });
});

