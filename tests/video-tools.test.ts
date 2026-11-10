import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkVideoToolsReport } from "@/server/media/tools";
import { checkBundledBinary, resolveMediaTool } from "@creator-lab/executors/media";
import { BUNDLED_CHECKSUMS, checksumKey } from "@creator-lab/executors/media-checksums";

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

test("every platform the bundled packages download for has a recorded SHA-256, and this install's binaries match", () => {
  const ffmpeg = ["darwin-arm64", "darwin-x64", "freebsd-x64", "linux-arm", "linux-arm64", "linux-ia32", "linux-x64", "win32-ia32", "win32-x64"];
  const ffprobe = ["darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64", "linux-ia32", "linux-x64", "win32-x64"];
  assert.deepEqual(Object.keys(BUNDLED_CHECKSUMS).sort(), [...ffmpeg.map((key) => `ffmpeg-${key}`), ...ffprobe.map((key) => `ffprobe-${key}`)].sort());
  for (const [key, entry] of Object.entries(BUNDLED_CHECKSUMS)) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, key);
    assert.equal(entry.release, key.startsWith("ffmpeg") ? "b6.0" : "b6.1.1", key);
  }
  const previous = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  delete process.env.FFMPEG_PATH;
  delete process.env.FFPROBE_PATH;
  try {
    for (const tool of ["ffmpeg", "ffprobe"] as const) {
      const resolved = resolveMediaTool(tool);
      assert.equal(resolved.source, "bundled", `${tool} on ${checksumKey(tool)} passes its checksum`);
      assert.equal(resolved.warning, undefined);
      assert.deepEqual(checkBundledBinary(tool, resolved.path), { ok: true });
    }
  } finally {
    if (previous.ffmpeg !== undefined) process.env.FFMPEG_PATH = previous.ffmpeg;
    if (previous.ffprobe !== undefined) process.env.FFPROBE_PATH = previous.ffprobe;
  }
});

test("a bundled binary that does not match its checksum is never run: the next candidate is used and the reason is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "creator-lab-checksum-"));
  const previous = process.env.FFMPEG_PATH;
  delete process.env.FFMPEG_PATH;
  try {
    const fake = join(dir, "ffmpeg");
    writeFileSync(fake, "#!/bin/sh\necho not ffmpeg\n");
    const genuine = { "ffmpeg-testos-testarch": { release: "b6.0", sha256: createHash("sha256").update("something else").digest("hex"), size: 26 } };
    const refused = resolveMediaTool("ffmpeg", { bundledPath: fake, platform: "testos", arch: "testarch", table: genuine });
    assert.notEqual(refused.path, fake, "the tampered binary is not the one returned");
    assert.ok(refused.source === "homebrew-full" || refused.source === "path");
    assert.match(refused.warning ?? "", /does not match the SHA-256 recorded for release b6\.0 on testos-testarch, so it was not run\. Run npm ci again .*or set FFMPEG_PATH/);

    const unknown = checkBundledBinary("ffmpeg", fake, { platform: "plan9", arch: "mips" });
    assert.equal(unknown.ok, false);
    assert.match(!unknown.ok ? unknown.reason : "", /No checksum is recorded for the bundled ffmpeg on plan9-mips/);

    const matching = { "ffmpeg-testos-testarch": { release: "b6.0", sha256: createHash("sha256").update("#!/bin/sh\necho not ffmpeg\n").digest("hex"), size: 26 } };
    assert.deepEqual(resolveMediaTool("ffmpeg", { bundledPath: fake, platform: "testos", arch: "testarch", table: matching }), { path: fake, source: "bundled" });

    process.env.FFMPEG_PATH = "/opt/custom/ffmpeg";
    assert.deepEqual(resolveMediaTool("ffmpeg", { bundledPath: fake, platform: "testos", arch: "testarch", table: genuine }), { path: "/opt/custom/ffmpeg", source: "environment" }, "FFMPEG_PATH is the way around a refused binary");
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
