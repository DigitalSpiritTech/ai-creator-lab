import assert from "node:assert/strict";
import { test } from "node:test";
import { checkVideoToolsReport } from "@/server/media/tools";
import { resolveMediaTool } from "@creator-lab/executors/media";

test("video tools report names the binaries, their versions, and whether captions work", async () => {
  const report = await checkVideoToolsReport(5);
  assert.equal(report.checkedAt, 5);
  assert.ok(report.ffmpeg.path.length > 0 && report.ffprobe.path.length > 0);
  assert.ok(["environment", "bundled", "homebrew-full", "path"].includes(report.source));
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

test("without FFMPEG_PATH and FFPROBE_PATH the bundled binaries are the default, and they can burn captions", async () => {
  const previous = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  delete process.env.FFMPEG_PATH;
  delete process.env.FFPROBE_PATH;
  try {
    const ffmpeg = resolveMediaTool("ffmpeg");
    const ffprobe = resolveMediaTool("ffprobe");
    assert.equal(ffmpeg.source, "bundled", "npm ci downloads ffmpeg-static for this platform");
    assert.equal(ffprobe.source, "bundled", "npm ci downloads @derhuerst/ffprobe-static for this platform");
    assert.match(ffmpeg.path, /node_modules[\\/]ffmpeg-static[\\/]ffmpeg(\.exe)?$/);
    assert.match(ffprobe.path, /node_modules[\\/]@derhuerst[\\/]ffprobe-static[\\/]ffprobe(\.exe)?$/);
    const report = await checkVideoToolsReport();
    assert.equal(report.source, "bundled");
    assert.equal(report.captions, true, report.message);
  } finally {
    if (previous.ffmpeg !== undefined) process.env.FFMPEG_PATH = previous.ffmpeg;
    if (previous.ffprobe !== undefined) process.env.FFPROBE_PATH = previous.ffprobe;
  }
});

test("FFMPEG_PATH and FFPROBE_PATH still override the bundled binaries", () => {
  const previous = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  process.env.FFMPEG_PATH = "/opt/custom/ffmpeg";
  process.env.FFPROBE_PATH = "/opt/custom/ffprobe";
  try {
    assert.deepEqual(resolveMediaTool("ffmpeg"), { path: "/opt/custom/ffmpeg", source: "environment" });
    assert.deepEqual(resolveMediaTool("ffprobe"), { path: "/opt/custom/ffprobe", source: "environment" });
  } finally {
    if (previous.ffmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous.ffmpeg;
    if (previous.ffprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previous.ffprobe;
  }
});
