/**
 * The Settings backend routes against a ComfyUI stand-in on 127.0.0.1 that serves the recorded
 * no-LTX object_info fixture. Loopback only, nothing leaves the machine, nothing is submitted. Checks
 * that adding probes at once, the key is never sent to the self-hosted server or echoed, redirects
 * are refused, and cross-site writes are blocked.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type IncomingHttpHeaders, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { RecipeBackendStatus } from "@/lib/catalog";

const empty = pathToFileURL(resolve("node_modules/server-only/empty.js")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: empty, shortCircuit: true, format: "commonjs" };
    return next(specifier, context);
  },
});

const FAKE_COMFY = "comfy-test-key-routes-4b7e";
const fixture = readFileSync(new URL("./fixtures/comfyui/object_info-local-no-ltx.json", import.meta.url), "utf8");
const dataDir = mkdtempSync(join(tmpdir(), "creator-lab-backends-"));
const savedEnv = { ...process.env };
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];

const server = createServer((request, response) => {
  seen.push({ path: request.url ?? "", headers: request.headers });
  if (request.url === "/object_info") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(fixture);
  } else if (request.url?.startsWith("/redirect")) {
    response.writeHead(302, { location: "/object_info" });
    response.end();
  } else {
    response.writeHead(404);
    response.end("not found");
  }
});
let base = "";

const url = (path: string) => `http://localhost:3000${path}`;
const json = (path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) =>
  new Request(url(path), { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

let routes: Awaited<ReturnType<typeof load>>;
async function load() {
  return {
    list: await import("@/app/api/settings/backends/route"),
    one: await import("@/app/api/settings/backends/[id]/route"),
    probe: await import("@/app/api/settings/backends/[id]/probe/route"),
    runtime: await import("@/server/runtime"),
  };
}

type View = {
  backends: { id: string; label: string; isDefault: boolean; builtIn: boolean; lastProbe: { ok: boolean; error?: string } | null }[];
  recipes: { id: string; statuses: Record<string, RecipeBackendStatus> }[];
  added?: { id: string; lastProbe: { ok: boolean; error?: string } | null };
  customAllowed: boolean;
};

before(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.STUDIO_DATA_DIR = dataDir;
  for (const name of ["COMFY_BASE_URL", "GENERATION_ALLOWANCE_USD", "HOST", "STUDIO_ALLOWED_HOSTS", "STUDIO_JUDGE_OPEN", "STUDIO_JUDGE_PASSWORD", "STUDIO_READ_ONLY"]) delete process.env[name];
  process.env.COMFY_API_KEY = FAKE_COMFY;
  routes = await load();
});

after(async () => {
  routes?.runtime.closeStore();
  process.env = savedEnv;
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe("backend routes", () => {
  test("GET lists Comfy Cloud and Router with every workflow recipe, and never the key", async () => {
    const response = await routes.list.GET();
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!text.includes(FAKE_COMFY));
    const view = JSON.parse(text) as View;
    assert.deepEqual(view.backends.map((backend) => backend.id), ["cloud", "router"]);
    assert.equal(view.backends[0].isDefault, true);
    assert.equal(view.customAllowed, true);
    assert.equal(view.recipes.find((recipe) => recipe.id === "ltx-2.5-i2v")?.statuses.cloud.status, "verified");
  });

  test("adding a ComfyUI probes it at once: LTX unavailable with the node names, Z-Image compatible, no key sent", async () => {
    seen.length = 0;
    const response = await routes.list.POST(json("/api/settings/backends", { kind: "comfyui", label: "Studio PC", baseUrl: `${base}/` }));
    const text = await response.text();
    assert.equal(response.status, 201, text);
    assert.ok(!text.includes(FAKE_COMFY));
    const view = JSON.parse(text) as View;
    assert.equal(view.added?.lastProbe?.ok, true);
    const id = view.added!.id;
    const ltx = view.recipes.find((recipe) => recipe.id === "ltx-2.5-i2v")!.statuses[id];
    assert.ok(ltx.status === "unavailable" && ltx.nodes.includes("LTXVConditioning"), JSON.stringify(ltx));
    assert.equal(view.recipes.find((recipe) => recipe.id === "ltx-2.5-i2v")!.statuses.cloud.status, "verified");
    assert.equal(view.recipes.find((recipe) => recipe.id === "z-image-turbo-t2i")!.statuses[id].status, "compatible");
    assert.deepEqual(seen.map((request) => request.path), ["/api/object_info", "/object_info"]);
    for (const request of seen) assert.ok(!JSON.stringify(request.headers).includes(FAKE_COMFY), "the key reached the self-hosted server");

    const defaulted = (await (await routes.one.PUT(json(`/api/settings/backends/${id}`, { default: true }, "PUT"), params({ id }))).json()) as View;
    assert.equal(defaulted.backends.find((backend) => backend.id === id)?.isDefault, true);
    const reprobed = await routes.probe.POST(new Request(url(`/api/settings/backends/${id}/probe`), { method: "POST" }), params({ id }));
    assert.equal(reprobed.status, 200);
    const removed = (await (await routes.one.DELETE(new Request(url(`/api/settings/backends/${id}`), { method: "DELETE" }), params({ id }))).json()) as View;
    assert.deepEqual(removed.backends.map((backend) => backend.id), ["cloud", "router"]);
    assert.equal(removed.backends[0].isDefault, true);
  });

  test("a redirect is refused, not followed", async () => {
    seen.length = 0;
    const response = await routes.list.POST(json("/api/settings/backends", { kind: "comfyui", label: "Redirecting", baseUrl: `${base}/redirect` }));
    const view = (await response.json()) as View;
    assert.equal(view.added?.lastProbe?.ok, false);
    assert.match(view.added?.lastProbe?.error ?? "", /could not be reached/);
    assert.ok(!seen.some((request) => request.path === "/object_info"), "the redirect target was fetched");
    const id = view.added!.id;
    await routes.one.DELETE(new Request(url(`/api/settings/backends/${id}`), { method: "DELETE" }), params({ id }));
  });

  test("bad addresses, built-in removal, unknown ids, and cross-site writes are refused", async () => {
    const bad = await routes.list.POST(json("/api/settings/backends", { kind: "comfyui", label: "Bad", baseUrl: "file:///etc/passwd" }));
    assert.equal(bad.status, 400);
    const cloud = await routes.one.DELETE(new Request(url("/api/settings/backends/cloud"), { method: "DELETE" }), params({ id: "cloud" }));
    assert.equal(cloud.status, 400);
    const unknown = await routes.probe.POST(new Request(url("/api/settings/backends/NOPE/probe"), { method: "POST" }), params({ id: "NOPE" }));
    assert.equal(unknown.status, 404);
    const crossSite = await routes.list.POST(json("/api/settings/backends", { kind: "comfyui", label: "X", baseUrl: base }, "POST", { Origin: "https://evil.example" }));
    assert.equal(crossSite.status, 403);
    const crossDelete = await routes.one.DELETE(new Request(url("/api/settings/backends/cloud"), { method: "DELETE", headers: { Origin: "https://evil.example" } }), params({ id: "cloud" }));
    assert.equal(crossDelete.status, 403);
  });
});
