import assert from "node:assert/strict";
import { test } from "node:test";
import { checkVideoToolsReport } from "@/server/media/tools";

test("video tools report names the binaries, their versions, and whether captions work", async () => {
  const report = await checkVideoToolsReport(5);
  assert.equal(report.checkedAt, 5);
  assert.ok(report.ffmpeg.path.length > 0 && report.ffprobe.path.length > 0);
  assert.ok(["environment", "homebrew-full", "path"].includes(report.source));
  assert.ok(report.message.length > 0);
  if (report.ffmpeg.version && report.ffprobe.version) {
    assert.match(report.ffmpeg.version, /\d/);
    assert.equal(typeof report.captions, "boolean");
  } else {
    assert.equal(report.captions, false);
    assert.match(report.message, /did not respond/);
  }
});

test("video tools report points at a missing binary without throwing", async () => {
  const previous = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
  process.env.FFPROBE_PATH = "/nonexistent/ffprobe";
  try {
    const report = await checkVideoToolsReport();
    assert.equal(report.ffmpeg.version, null);
    assert.equal(report.captions, false);
    assert.equal(report.source, "environment");
    assert.match(report.message, /ffmpeg did not respond at \/nonexistent\/ffmpeg/);
  } finally {
    if (previous.ffmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous.ffmpeg;
    if (previous.ffprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previous.ffprobe;
  }
});
