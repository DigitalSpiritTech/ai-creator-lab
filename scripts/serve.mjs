#!/usr/bin/env node
/**
 * Starts Next.js (`dev` or `start`) on the address in `HOST`, 127.0.0.1 when unset, so the studio
 * listens on this computer only unless someone asks otherwise. Any non-loopback `HOST` (0.0.0.0,
 * a LAN address) turns on the app password; the server log prints a one-time setup code on the
 * first such start. Extra arguments go to Next.js (`npm start -- --port 4000`).
 *
 * Plain JavaScript so `npm start` works without dev dependencies.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";

const [command, ...rest] = process.argv.slice(2);
if (command !== "dev" && command !== "start") {
  console.error("Usage: node scripts/serve.mjs <dev|start> [next options]");
  process.exit(2);
}
if (rest.some((argument) => argument === "-H" || argument === "--hostname" || argument.startsWith("--hostname="))) {
  console.error("Set the address with HOST (for example HOST=0.0.0.0 npm start), not --hostname, so the studio knows to ask for its password.");
  process.exit(2);
}

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
// Read `.env.local` and friends the way Next.js will, so a HOST set there is the address used.
createRequire(next)("@next/env").loadEnvConfig(process.cwd(), command === "dev", { info: () => {}, error: console.error });
const host = process.env.HOST?.trim() || "127.0.0.1";
const child = spawn(process.execPath, [next, command, "--hostname", host, ...rest], {
  stdio: "inherit",
  env: { ...process.env, HOST: host },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 0));
});
