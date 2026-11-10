/**
 * The launcher's decisions, apart from the launcher so they can be tested: loading `.env.local`
 * (and the other env files) the way Next.js and `serve.mjs` do, which data folder to use and where
 * that setting came from, and the build stamp that says which commit `.next` was built from.
 *
 * Plain JavaScript with no dependencies beyond Next.js's own `@next/env`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** The settings the launcher reads from the environment or the env files. */
export const LAUNCH_KEYS = ["STUDIO_DATA_DIR", "HOST", "PORT"];

/**
 * Loads `.env.production.local`, `.env.local`, `.env.production`, and `.env` from `root` into
 * `process.env` the way `next start` will (variables already set in the environment win), and
 * says where each launch setting came from: `"environment"`, an env file's name, or undefined.
 */
export function loadLocalEnv(root) {
  const before = Object.fromEntries(LAUNCH_KEYS.map((key) => [key, process.env[key]]));
  let loadedEnvFiles = [];
  try {
    // Next.js as this script finds it (the clone's or the installed package's node_modules).
    const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
    ({ loadedEnvFiles } = createRequire(next)("@next/env").loadEnvConfig(root, false, { info: () => {}, error: console.error }));
  } catch {
    // Next.js is not installed yet; the launcher stops with its own message later.
  }
  const sources = {};
  for (const key of LAUNCH_KEYS) {
    if (before[key] !== undefined && before[key] !== "") {
      sources[key] = "environment";
      continue;
    }
    const file = loadedEnvFiles.find((entry) => entry.env?.[key] !== undefined && entry.env[key] !== "");
    if (file) sources[key] = basename(file.path);
  }
  return { files: loadedEnvFiles.map((file) => basename(file.path)), sources };
}

/**
 * The data folder and where the choice came from, first match wins: `--data`, `STUDIO_DATA_DIR`
 * (the environment or an env file), then `.data` in a clone or `~/.ai-creator-lab` in an
 * installed copy. Relative paths resolve against the repository root, as the server's do.
 * @param {{ option?: string, env?: Record<string, string | undefined>, sources?: Record<string, string>, root: string, clone: boolean, home?: string }} choice
 * @returns {{ dir: string, source: string }}
 */
export function chooseDataDir({ option, env = process.env, sources = {}, root, clone, home = homedir() }) {
  if (option) return { dir: resolve(root, option), source: "--data" };
  const configured = env.STUDIO_DATA_DIR?.trim();
  if (configured) {
    const where = sources.STUDIO_DATA_DIR && sources.STUDIO_DATA_DIR !== "environment" ? `STUDIO_DATA_DIR in ${sources.STUDIO_DATA_DIR}` : "STUDIO_DATA_DIR in the environment";
    return { dir: resolve(root, configured), source: where };
  }
  return clone
    ? { dir: resolve(root, ".data"), source: "the default for a clone (.data in the repository)" }
    : { dir: join(home, ".ai-creator-lab"), source: "the default for an installed copy (~/.ai-creator-lab)" };
}

/** Whether a HOST value means this computer only. */
export function isLoopbackHost(host) {
  const value = host?.trim();
  return !value || ["127.0.0.1", "localhost", "::1"].includes(value);
}

/** The commit HEAD points at, or null outside a git checkout. */
export function gitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function stampPath(root) {
  return join(root, "apps", "creator", ".next", "creator-lab-build.json");
}

/** The commit the current `.next` was built from, or null when unknown. */
export function readBuildStamp(root) {
  try {
    return JSON.parse(readFileSync(stampPath(root), "utf8")).commit ?? null;
  } catch {
    return null;
  }
}

/** Records the commit a fresh build was made from (`npm run build` and the launcher both call this). */
export function writeBuildStamp(root, head = gitHead(root)) {
  writeFileSync(stampPath(root), `${JSON.stringify({ commit: head, builtAt: new Date().toISOString() })}\n`);
}
