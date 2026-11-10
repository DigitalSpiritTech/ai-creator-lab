#!/usr/bin/env node
/**
 * `npx ai-creator-lab`: starts the studio for one person on this computer. It checks Node (22.13 or
 * newer, for the built-in `node:sqlite`), prepares the data folder, makes sure a production build
 * exists, and runs the production server on 127.0.0.1 (never another address; for a server, use
 * `HOST=... npm start` or the Docker image, which turn on the app password).
 *
 * Two layouts, one script:
 * - A clone (`git clone`, `npm ci`): the data folder is `.data` in the clone, as with `npm start`.
 *   The first run builds the app (`next build`), and builds again after `git pull` moves HEAD, so
 *   the build always matches the source. A clone has the build tools from `npm ci`.
 * - An installed package (`npx ai-creator-lab` from npm): the package ships a prebuilt `.next`, so
 *   nothing is compiled on the user's machine and no build tools are installed. The data folder is
 *   `~/.ai-creator-lab`, outside the package, so updating or clearing the npx cache keeps your work.
 *
 * Options: --port <n> (default PORT, else the first free port from 3000), --data <dir> (default
 * STUDIO_DATA_DIR, else as above), --rebuild (build even if a build exists), --no-build (never
 * build), --open (open the browser), --help. Keys go in Settings (stored in the data folder) or in
 * `.env.local` in a clone.
 *
 * Plain JavaScript with no dependencies, so it runs before anything else is checked.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MINIMUM = [22, 13];
const root = fileURLToPath(new URL("../../../", import.meta.url));
const appDir = join(root, "apps", "creator");
const buildStamp = join(appDir, ".next", "creator-lab-build.json");

function say(message) {
  console.log(`[ai-creator-lab] ${message}`);
}

function stop(message, code = 1) {
  console.error(`[ai-creator-lab] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { port: undefined, data: undefined, rebuild: false, build: true, open: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => argv[++index] ?? stop(`${argument} needs a value.`, 2);
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: npx ai-creator-lab [--port 3000] [--data <folder>] [--rebuild | --no-build] [--open]\nStarts AI Creator Lab on http://127.0.0.1 for this computer only. See docs/QUICKSTART.md.");
      process.exit(0);
    } else if (argument === "--port") options.port = value();
    else if (argument.startsWith("--port=")) options.port = argument.slice(7);
    else if (argument === "--data") options.data = value();
    else if (argument.startsWith("--data=")) options.data = argument.slice(7);
    else if (argument === "--rebuild") options.rebuild = true;
    else if (argument === "--no-build") options.build = false;
    else if (argument === "--open") options.open = true;
    else stop(`Unknown option ${argument}. Run with --help for the options.`, 2);
  }
  if (options.port !== undefined && !/^\d{2,5}$/.test(options.port)) stop("--port takes a number, for example --port 4000.", 2);
  return options;
}

/** Node 22.13 or newer, where `node:sqlite` works without a flag. */
async function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MINIMUM[0] || (major === MINIMUM[0] && minor < MINIMUM[1])) {
    stop(`AI Creator Lab needs Node ${MINIMUM.join(".")} or newer; this is Node ${process.versions.node}. Install the current LTS from https://nodejs.org and run this again.`);
  }
  try {
    await import("node:sqlite");
  } catch {
    stop(`This Node (${process.versions.node}) has no built-in node:sqlite. Install Node ${MINIMUM.join(".")} or newer from https://nodejs.org.`);
  }
}

function isClone() {
  return existsSync(join(root, ".git"));
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function builtFor() {
  try {
    return JSON.parse(readFileSync(buildStamp, "utf8")).commit ?? null;
  } catch {
    return null;
  }
}

/** Whether `next build` can run here: the CSS toolchain is a dev dependency, present in a clone after `npm ci`. */
function canBuild() {
  try {
    const require = createRequire(join(appDir, "package.json"));
    require.resolve("@tailwindcss/postcss");
    require.resolve("next/dist/bin/next");
    return true;
  } catch {
    return false;
  }
}

function ensureBuild(options) {
  const built = existsSync(join(appDir, ".next", "BUILD_ID"));
  const clone = isClone();
  const head = clone ? gitHead() : null;
  const stale = built && clone && head !== null && builtFor() !== head;
  if (built && !options.rebuild && (!stale || !options.build)) return;
  if (!options.build) stop("There is no production build yet. Run without --no-build, or run npm run build first.");
  if (!canBuild()) {
    stop(built ? "This copy cannot rebuild (the build tools are not installed); start it without --rebuild." : "This copy has no production build and no build tools. In a clone, run npm ci first.");
  }
  say(built ? (options.rebuild ? "Rebuilding the app." : "The source changed since the last build; building again (a minute or two).") : "Building the app for the first time (a minute or two).");
  const next = createRequire(join(appDir, "package.json")).resolve("next/dist/bin/next");
  const result = spawnSync(process.execPath, [next, "build", appDir, "--webpack"], { cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  if (result.status !== 0) stop("The build failed; the messages above say why.");
  writeFileSync(buildStamp, `${JSON.stringify({ commit: head, builtAt: new Date().toISOString() })}\n`);
}

function prepareDataDir(options) {
  const chosen = options.data ?? process.env.STUDIO_DATA_DIR?.trim();
  const dataDir = resolve(root, chosen || (isClone() ? ".data" : join(homedir(), ".ai-creator-lab")));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return dataDir;
}

function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

async function choosePort(options) {
  const asked = options.port ?? process.env.PORT?.trim();
  if (asked) {
    if (!(await portFree(Number(asked)))) stop(`Port ${asked} is in use on 127.0.0.1. Pick another with --port.`);
    return Number(asked);
  }
  for (let port = 3000; port < 3020; port += 1) if (await portFree(port)) return port;
  stop("Ports 3000 to 3019 are all in use. Pick one with --port.");
}

async function waitUntilReady(base, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const ready = await fetch(`${base}/api/auth/session`).then((response) => response.ok, () => false);
    if (ready) return true;
    await new Promise((wait) => setTimeout(wait, 300));
  }
  return false;
}

function openBrowser(url) {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => say(`Open ${url} in your browser.`)).unref();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await checkNode();
  if (process.env.HOST && !["127.0.0.1", "localhost", "::1"].includes(process.env.HOST.trim())) {
    say(`Ignoring HOST=${process.env.HOST}: this launcher serves this computer only. For a server, use HOST=... npm start or the Docker image.`);
  }
  const dataDir = prepareDataDir(options);
  ensureBuild(options);
  const port = await choosePort(options);
  const base = `http://127.0.0.1:${port}`;
  say(`Data folder: ${dataDir}`);
  const child = spawn(process.execPath, [join(appDir, "scripts", "serve.mjs"), "start", "--port", String(port)], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", STUDIO_DATA_DIR: dataDir },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  if (await waitUntilReady(base, child)) {
    say(`AI Creator Lab is running at ${base} (this computer only). Press Ctrl+C to stop.`);
    if (options.open) openBrowser(base);
  }
}

main().catch((error) => stop(error instanceof Error ? error.message : String(error)));
