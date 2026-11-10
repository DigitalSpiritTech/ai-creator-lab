/**
 * `npx ai-creator-lab`'s decisions: the env files load before the data folder is chosen (so a
 * STUDIO_DATA_DIR in `.env.local` finds your projects), the startup line can say where the folder
 * setting came from, HOST from an env file is noticed, and the build stamp lets a build from
 * `npm run build` start without rebuilding.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { chooseDataDir, isLoopbackHost, readBuildStamp, writeBuildStamp } from "../apps/creator/scripts/launch-config.mjs";

const CONFIG = pathToFileURL(resolve("apps/creator/scripts/launch-config.mjs")).href;
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(envLocal?: string): string {
  const root = mkdtempSync(join(tmpdir(), "creator-lab-launch-"));
  roots.push(root);
  if (envLocal !== undefined) writeFileSync(join(root, ".env.local"), envLocal);
  return root;
}

/** Runs loadLocalEnv and chooseDataDir in a fresh Node, as the launcher does, with only `env` set. */
function launchDecision(root: string, env: Record<string, string> = {}): { files: string[]; sources: Record<string, string>; data: { dir: string; source: string }; host: string | null } {
  const script = `
    const { chooseDataDir, loadLocalEnv } = await import(${JSON.stringify(CONFIG)});
    const root = ${JSON.stringify(root)};
    const { files, sources } = loadLocalEnv(root);
    const data = chooseDataDir({ env: process.env, sources, root, clone: true });
    console.log(JSON.stringify({ files, sources, data, host: process.env.HOST ?? null }));`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["STUDIO_DATA_DIR", "HOST", "PORT", "NODE_ENV"].includes(key)));
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...clean, ...env } as NodeJS.ProcessEnv, encoding: "utf8" });
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

describe("launcher: the data folder", () => {
  test("a STUDIO_DATA_DIR in .env.local is honored and named as the source", () => {
    const root = tempRoot("STUDIO_DATA_DIR=studio-data\nHOST=0.0.0.0\n");
    const decision = launchDecision(root);
    assert.ok(decision.files.includes(".env.local"));
    assert.deepEqual(decision.data, { dir: join(root, "studio-data"), source: "STUDIO_DATA_DIR in .env.local" });
    assert.equal(decision.sources.HOST, ".env.local");
    assert.equal(decision.host, "0.0.0.0", "HOST is read, so the launcher can say it ignores it");
  });

  test("the environment wins over .env.local, and nothing set means the clone's .data", () => {
    const root = tempRoot("STUDIO_DATA_DIR=from-file\n");
    const fromEnv = launchDecision(root, { STUDIO_DATA_DIR: join(root, "from-env") });
    assert.deepEqual(fromEnv.data, { dir: join(root, "from-env"), source: "STUDIO_DATA_DIR in the environment" });
    const plain = launchDecision(tempRoot());
    assert.match(plain.data.source, /default for a clone/);
    assert.ok(plain.data.dir.endsWith(".data"));
  });

  test("--data wins over everything; an installed copy keeps its data in the home folder", () => {
    const root = "/opt/studio";
    assert.deepEqual(chooseDataDir({ option: "here", env: { STUDIO_DATA_DIR: "there" }, sources: { STUDIO_DATA_DIR: "environment" }, root, clone: true }), { dir: resolve(root, "here"), source: "--data" });
    assert.deepEqual(chooseDataDir({ env: {}, sources: {}, root, clone: false, home: "/home/avery" }), { dir: join("/home/avery", ".ai-creator-lab"), source: "the default for an installed copy (~/.ai-creator-lab)" });
  });

  test("only loopback names count as this computer", () => {
    for (const host of [undefined, "", "127.0.0.1", "localhost", "::1"]) assert.equal(isLoopbackHost(host), true, String(host));
    for (const host of ["0.0.0.0", "192.168.1.20", "studio.lan"]) assert.equal(isLoopbackHost(host), false, host);
  });
});

describe("launcher: the build stamp", () => {
  test("npm run build stamps the commit, so the launcher starts that build instead of rebuilding", () => {
    const root = tempRoot();
    mkdirSync(join(root, "apps", "creator", ".next"), { recursive: true });
    assert.equal(readBuildStamp(root), null, "no stamp: unknown build");
    writeBuildStamp(root, "abc123");
    assert.equal(readBuildStamp(root), "abc123");
    writeBuildStamp(root, null);
    assert.equal(readBuildStamp(root), null);
  });

  test("the build script stamps after next build", async () => {
    const { default: manifest } = await import("../package.json", { with: { type: "json" } });
    assert.match(manifest.scripts.build, /next build apps\/creator --webpack && node apps\/creator\/scripts\/build-stamp\.mjs$/);
  });
});
