import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";
import type { Asset } from "@/lib/domain/asset";
import { type ExportRecord, updateCut } from "@/lib/domain/content";
import { captionFilters, escapeDrawtext, layoutCaption, wrapCaption } from "@/server/assembly";
import { CAPTION_SAFE_WIDTH, captionFontPath, lineWidth } from "@/server/assembly/captions";
import { probeVideo } from "@/server/executors/media";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import { openStore } from "@/server/store";
import { callTool, createToolContext } from "@/server/tools";
import { approvedContent, audioRms, beatsWith, ffmpeg, frameAt, importClip, meanColor, pixelDifference } from "./support/assembly-fixtures";
import { clock, seedProject, tempStore } from "./support/domain-fixtures";

const execute = promisify(execFile);

type Assembled = { export: ExportRecord; asset: Asset | null };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const project = seedProject(context.store, now);
  return { ...context, now, project, tools: createToolContext(context.store) };
}

async function assemble(tools: ReturnType<typeof createToolContext>, input: Record<string, unknown>): Promise<Assembled> {
  const result = await callTool(tools, "assemble_ad", input);
  if (!result.ok) assert.fail(`assemble_ad failed: ${result.failure.code} ${result.failure.message}`);
  const output = result.output as Assembled;
  assert.equal(output.export.status, "completed", JSON.stringify(output.export));
  assert.ok(output.asset);
  return output;
}

function segmentMidpoints(record: ExportRecord): number[] {
  let start = 0;
  return record.sources.map((source) => {
    const middle = start + source.durationSeconds / 2;
    start += source.durationSeconds;
    return middle;
  });
}

const CENTER = { x: 530, y: 950, width: 20, height: 20 };

describe("captions layout", () => {
  test("wraps to at most two balanced lines and always fits the safe width", () => {
    assert.deepEqual(wrapCaption("  Fits the   cup holder. "), ["Fits the cup holder."]);
    assert.deepEqual(wrapCaption("Cold for\nall 24 hours\nreally"), ["Cold for", "all 24 hours really"]);
    assert.deepEqual(wrapCaption("Keeps drinks cold twenty four hours"), ["Keeps drinks cold", "twenty four hours"]);
    assert.equal(layoutCaption("   "), null);
    for (const text of ["Fits the cup holder.", "WWWWWW MMMMMM WWWWWW MMMMMM WWWWWW MMMMMM", "Dishwasher safe.\nCold 24 hours. Fits cup holders too."]) {
      const layout = layoutCaption(text)!;
      assert.ok(layout.lines.length <= 2);
      for (const line of layout.lines) assert.ok(lineWidth(line, layout.fontSize) <= CAPTION_SAFE_WIDTH, `${line} at ${layout.fontSize}px`);
      assert.equal(layout.baselines.at(-1), Math.round(1920 * 0.78));
    }
    assert.equal(layoutCaption("Fits the cup holder.")!.fontSize, 64);
  });

  test("escapes drawtext specials for both filter parsers, and an empty caption draws nothing", () => {
    assert.equal(escapeDrawtext("a:b"), "a\\\\:b");
    assert.equal(escapeDrawtext("it's"), "it\\\\\\'s");
    assert.equal(escapeDrawtext("x,y;[z]"), "x\\,y\\;\\[z\\]");
    assert.equal(escapeDrawtext("50%"), "50%");
    assert.equal(escapeDrawtext("C\\d"), "C\\\\\\\\d");
    assert.equal(captionFilters("", "/fonts/a.ttf"), "");
    assert.match(captionFilters("Hi", "/fonts/a.ttf"), /expansion=none/);
  });

  test("escaped text renders exactly like the same text read from a file", async () => {
    const font = captionFontPath();
    assert.ok(font, "bundled caption font is present");
    const text = `50% off: it's "real", [ok]; C:\\tmp`;
    const layout = layoutCaption(text)!;
    const work = await mkdtemp(join(tmpdir(), "caption-escape-"));
    try {
      const reference = await Promise.all(
        layout.lines.map(async (line, index) => {
          const file = join(work, `line-${index}.txt`);
          await writeFile(file, line);
          return [
            `drawtext=fontfile=${escapeDrawtext(font)}`,
            `textfile=${escapeDrawtext(file)}`,
            "expansion=none",
            `fontsize=${layout.fontSize}`,
            "fontcolor=white",
            "shadowcolor=black@0.75",
            "shadowx=4",
            "shadowy=4",
            "x=(w-text_w)/2",
            `y=${layout.baselines[index]}-ascent`,
          ].join(":");
        }),
      );
      const render = async (filter: string) => {
        const { stdout } = await execute(
          ffmpeg(),
          ["-v", "error", "-f", "lavfi", "-i", "color=c=0x336699:s=1080x1920:d=0.1", "-vf", filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
          { encoding: "buffer", maxBuffer: 16_000_000 },
        );
        return stdout;
      };
      const escaped = await render(captionFilters(text, font));
      const fromFile = await render(reference.join(","));
      assert.equal(pixelDifference(escaped, fromFile), 0);
      const plain = await render("null");
      assert.ok(pixelDifference(escaped, plain) > 0.1, "text was drawn");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("assembly", () => {
  test("joins mixed sizes, rates, and audio in cut order at 1080 x 1920, 24 fps, filling silence", async () => {
    const { store, now, project, tools } = setup();
    const red = await importClip(store, project.id, { color: "red", width: 90, height: 160, rate: 24, seconds: 0.5, audio: true }, now());
    const blue = await importClip(store, project.id, { color: "blue", width: 160, height: 90, rate: 30, seconds: 0.75, audio: false }, now());
    const lime = await importClip(store, project.id, { color: "lime", width: 720, height: 1280, rate: 25, seconds: 1, audio: true }, now());
    const pattern = await importClip(store, project.id, { color: "testsrc", width: 640, height: 360, rate: 24, seconds: 0.5, audio: false }, now());
    const clips = [red, blue, lime, pattern];
    let content = await approvedContent(store, project.id, beatsWith(["One.", "Two.", "Three.", "Four."]), clips, now);
    const order = [content.shots[2].id, content.shots[0].id, content.shots[1].id, content.shots[3].id];
    content = store.content.update(updateCut(content, { order, captions: false }, now()));

    const { export: record, asset } = await assemble(tools, { contentId: content.id });
    assert.deepEqual(record.sources.map((source) => source.assetId), [lime.id, red.id, blue.id, pattern.id]);
    assert.deepEqual(record.sources.map((source) => source.sha256), [lime.sha256, red.sha256, blue.sha256, pattern.sha256]);
    assert.equal(record.status === "completed" && record.assetId, asset!.id);
    assert.equal(record.scriptVersion, 1);
    assert.deepEqual(record.options, { mute: false, captions: false });
    assert.match(record.status === "completed" ? record.filterSummary : "", /concat filter n=4:v=1:a=1/);
    assert.equal(asset!.kind, "export");
    assert.deepEqual(asset!.provenance, { source: "export", exportId: record.id, contentId: content.id });

    const path = resolveMediaPath(store.dataDir, asset!.relativePath);
    const expected = record.sources.reduce((sum, source) => sum + source.durationSeconds, 0);
    const info = await probeVideo(path);
    assert.equal(info.codec, "h264");
    assert.deepEqual([info.width, info.height, info.fps], [1080, 1920, 24]);
    assert.ok(Math.abs(info.durationSeconds - expected) <= 0.1, `${info.durationSeconds} vs ${expected}`);
    assert.equal(info.frames, Math.round(expected * 24));
    assert.equal(info.hasAudio, true);
    assert.equal(sha256(await readFile(path)), asset!.sha256);
    assert.ok(existsSync(resolveMediaPath(store.dataDir, asset!.video!.posterPath!)));

    const [limeMid, redMid, blueMid] = segmentMidpoints(record);
    const [limeColor, redColor, blueColor] = await Promise.all([limeMid, redMid, blueMid].map(async (time) => meanColor(await frameAt(path, time, CENTER))));
    assert.ok(limeColor[1] > 200 && limeColor[0] < 40 && limeColor[2] < 40, `lime first: ${limeColor}`);
    assert.ok(redColor[0] > 200 && redColor[1] < 40 && redColor[2] < 40, `red second: ${redColor}`);
    assert.ok(blueColor[2] > 200 && blueColor[0] < 40 && blueColor[1] < 40, `blue third: ${blueColor}`);
    const corner = meanColor(await frameAt(path, blueMid, { x: 0, y: 0, width: 20, height: 20 }));
    assert.ok(corner.every((channel) => channel < 20), "letterbox padding is black");

    const starts = [0, record.sources[0].durationSeconds, record.sources[0].durationSeconds + record.sources[1].durationSeconds];
    assert.ok((await audioRms(path, starts[0] + 0.1, starts[1] - 0.1)) > 0.02, "lime keeps its tone");
    assert.ok((await audioRms(path, starts[1] + 0.1, starts[2] - 0.1)) > 0.02, "red keeps its tone");
    assert.ok((await audioRms(path, starts[2] + 0.1, starts[2] + record.sources[2].durationSeconds - 0.1)) < 0.001, "silent clip gets silence");

    for (const clip of clips) assert.equal(sha256(await readFile(resolveMediaPath(store.dataDir, clip.relativePath))), clip.sha256);
  });

  test("a muted export has no audio stream and saves the mute choice on the cut", async () => {
    const { store, now, project, tools } = setup();
    const clip = await importClip(store, project.id, { color: "red", width: 90, height: 160, rate: 24, seconds: 0.5, audio: true }, now());
    const content = await approvedContent(store, project.id, beatsWith(["Muted."]), [clip], now);
    const { export: record, asset } = await assemble(tools, { contentId: content.id, mute: true, captions: false });
    assert.equal(record.options.mute, true);
    assert.equal(asset!.video!.hasAudio, false);
    assert.equal((await probeVideo(resolveMediaPath(store.dataDir, asset!.relativePath))).hasAudio, false);
    assert.equal(store.content.getRequired(content.id).cut.mute, true);
  });

  test("captions burn in for beats with text, stay inside the margins, and skip empty text", async () => {
    const { store, now, project, tools } = setup();
    const first = await importClip(store, project.id, { color: "blue", width: 90, height: 160, rate: 24, seconds: 0.5, audio: false }, now());
    const second = await importClip(store, project.id, { color: "blue", width: 90, height: 160, rate: 24, seconds: 0.5, audio: false }, now());
    const content = await approvedContent(store, project.id, beatsWith(["Keeps drinks cold twenty four hours", ""]), [first, second], now);
    const captioned = await assemble(tools, { contentId: content.id, exportId: randomUUID(), captions: true });
    const plain = await assemble(tools, { contentId: content.id, exportId: randomUUID(), captions: false });
    assert.match(captioned.export.status === "completed" ? captioned.export.filterSummary : "", /drawtext captions/);
    const pathOf = (result: Assembled) => resolveMediaPath(store.dataDir, result.asset!.relativePath);
    const band = { x: 0, y: 1300, width: 1080, height: 260 };
    const withText = await frameAt(pathOf(captioned), 0.25, band);
    const without = await frameAt(pathOf(plain), 0.25, band);
    assert.ok(pixelDifference(withText, without) > 2, "caption drawn on the first beat");
    const margin = { x: 0, y: 1300, width: 50, height: 260 };
    assert.ok(pixelDifference(await frameAt(pathOf(captioned), 0.25, margin), await frameAt(pathOf(plain), 0.25, margin)) < 1, "text stays out of the side margins");
    const top = { x: 0, y: 100, width: 1080, height: 200 };
    assert.ok(pixelDifference(await frameAt(pathOf(captioned), 0.25, top), await frameAt(pathOf(plain), 0.25, top)) < 1);
    assert.ok(pixelDifference(await frameAt(pathOf(captioned), 0.75, band), await frameAt(pathOf(plain), 0.75, band)) < 1, "empty caption draws nothing");
  });

  test("refuses with the first unapproved beat named and saves nothing", async () => {
    const { store, now, project, tools } = setup();
    const clip = await importClip(store, project.id, { color: "red", width: 90, height: 160, rate: 24, seconds: 0.5, audio: false }, now());
    const content = await approvedContent(store, project.id, beatsWith(["One.", "Two.", "Three."]), [clip, null, null], now);
    const result = await callTool(tools, "assemble_ad", { contentId: content.id });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.failure.code, "invalid");
    assert.match(!result.ok ? result.failure.message : "", /^Beat 2 has no approved clip/);
    assert.equal(store.content.listExports(content.id).length, 0);
  });

  test("the same export id never renders twice, and the export survives reopening the store", async () => {
    const { store, dir, now, project, tools } = setup();
    const clip = await importClip(store, project.id, { color: "lime", width: 160, height: 90, rate: 30, seconds: 0.5, audio: true }, now());
    const content = await approvedContent(store, project.id, beatsWith(["Again."]), [clip], now);
    const exportId = randomUUID();
    const [first, concurrent] = await Promise.all([
      assemble(tools, { contentId: content.id, exportId }),
      assemble(tools, { contentId: content.id, exportId }),
    ]);
    assert.deepEqual(concurrent, first);
    const again = await assemble(tools, { contentId: content.id, exportId });
    assert.deepEqual(again, first);
    assert.equal(store.content.listExports(content.id).length, 1);
    assert.equal(store.assets.list({ kind: "export" }).length, 1);
    const changed = await callTool(tools, "assemble_ad", { contentId: content.id, exportId, mute: true });
    assert.equal(!changed.ok && changed.failure.code, "conflict");

    store.close();
    const reopened = openStore(dir);
    try {
      assert.deepEqual(reopened.content.getExport(exportId), first.export);
      const asset = reopened.assets.getRequired(first.asset!.id);
      assert.deepEqual(asset, first.asset);
      assert.equal(sha256(await readFile(resolveMediaPath(dir, asset.relativePath))), asset.sha256);
      const result = await callTool(createToolContext(reopened), "assemble_ad", { contentId: content.id, exportId });
      assert.deepEqual(result.ok && result.output, first);
    } finally {
      reopened.close();
    }
  });
});
