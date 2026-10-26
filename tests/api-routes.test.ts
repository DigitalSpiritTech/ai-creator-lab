/**
 * API route handlers against a temporary workspace: projects, settings (keys never echoed), the
 * tool route, the spending gate with the mock recipe, jobs polling, asset streaming with ranges,
 * delete-everywhere usage, and the chat stream. No network: no keys are configured.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createSseParser } from "@/lib/client/sse";

// Route modules import `server-only`; outside the React server build it would throw on import.
const empty = pathToFileURL(resolve("node_modules/server-only/empty.js")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: empty, shortCircuit: true, format: "commonjs" };
    return next(specifier, context);
  },
});

const FAKE_COMFY = "comfy-test-key-7f3a9c1e5b";
const FAKE_ANTHROPIC = "anthropic-test-key-2d8e4b6a0c";
const dataDir = mkdtempSync(join(tmpdir(), "creator-lab-api-"));
const savedEnv = { ...process.env };

type Params<T> = { params: Promise<T> };
const params = <T>(value: T): Params<T> => ({ params: Promise.resolve(value) });
const url = (path: string) => `http://localhost:3000${path}`;
const json = (path: string, body: unknown, method = "POST") =>
  new Request(url(path), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let routes: Awaited<ReturnType<typeof loadRoutes>>;

async function loadRoutes() {
  return {
    projects: await import("@/app/api/projects/route"),
    project: await import("@/app/api/projects/[id]/route"),
    tools: await import("@/app/api/projects/[id]/tools/[name]/route"),
    workspaceTools: await import("@/app/api/tools/[name]/route"),
    submit: await import("@/app/api/projects/[id]/proposals/submit/route"),
    jobs: await import("@/app/api/projects/[id]/jobs/route"),
    asset: await import("@/app/api/assets/[id]/route"),
    usage: await import("@/app/api/assets/[id]/usage/route"),
    assets: await import("@/app/api/assets/route"),
    settings: await import("@/app/api/settings/route"),
    keys: await import("@/app/api/settings/keys/route"),
    recipes: await import("@/app/api/recipes/route"),
    library: await import("@/app/api/library/route"),
    chat: await import("@/app/api/projects/[id]/chat/route"),
    runtime: await import("@/server/runtime"),
  };
}

before(async () => {
  process.env.STUDIO_DATA_DIR = dataDir;
  for (const name of ["COMFY_API_KEY", "ANTHROPIC_API_KEY", "LLM_MODEL", "GENERATION_ALLOWANCE_USD", "COMFY_BASE_URL"]) delete process.env[name];
  routes = await loadRoutes();
});

after(() => {
  routes?.runtime.closeStore();
  process.env = savedEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

async function createProject(name = "Ridgeline bottle, October"): Promise<string> {
  const response = await routes.projects.POST(json("/api/projects", { name }));
  assert.equal(response.status, 201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

describe("settings", () => {
  test("keys are written to a 0600 file and never appear in any settings response", async () => {
    const saved = await routes.keys.POST(json("/api/settings/keys", { comfyApiKey: FAKE_COMFY, anthropicApiKey: FAKE_ANTHROPIC, llmModel: "claude-opus-5-5" }));
    assert.equal(saved.status, 200);
    const savedText = await saved.text();
    assert.ok(!savedText.includes(FAKE_COMFY) && !savedText.includes(FAKE_ANTHROPIC), "keys POST echoed a key");

    const mode = statSync(join(dataDir, "secrets.json")).mode & 0o777;
    assert.equal(mode, 0o600);

    const response = await routes.settings.GET();
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(FAKE_COMFY), "settings GET contains the Comfy key");
    assert.ok(!text.includes(FAKE_ANTHROPIC), "settings GET contains the Anthropic key");
    const body = JSON.parse(text) as { keys: { comfyApiKey: { present: boolean; source: string }; anthropicApiKey: { present: boolean }; llmModel: { value: string } } };
    assert.deepEqual(body.keys.comfyApiKey, { present: true, source: "settings" });
    assert.equal(body.keys.anthropicApiKey.present, true);
    assert.equal(body.keys.llmModel.value, "claude-opus-5-5");

    const updated = await routes.settings.PUT(json("/api/settings", { autoApprove: true, allowanceUsd: 2 }, "PUT"));
    const updatedText = await updated.text();
    assert.equal(updated.status, 200);
    assert.ok(!updatedText.includes(FAKE_COMFY) && !updatedText.includes(FAKE_ANTHROPIC));
    const settings = JSON.parse(updatedText) as { workspace: { autoApprove: boolean }; allowance: { effectiveUsd: number } };
    assert.equal(settings.workspace.autoApprove, true);
    assert.equal(settings.allowance.effectiveUsd, 0, "no operator allowance means no paid runs");

    // Clear the keys so the rest of the suite runs offline on the mock executor.
    const cleared = await routes.keys.POST(json("/api/settings/keys", { comfyApiKey: null, anthropicApiKey: "" }));
    const status = (await cleared.json()) as { keys: { comfyApiKey: { present: boolean }; anthropicApiKey: { present: boolean } } };
    assert.equal(status.keys.comfyApiKey.present, false);
    assert.equal(status.keys.anthropicApiKey.present, false);
  });

  test("rejects non-JSON writes and unknown fields", async () => {
    const plain = await routes.keys.POST(new Request(url("/api/settings/keys"), { method: "POST", body: "x" }));
    assert.equal(plain.status, 415);
    const extra = await routes.settings.PUT(json("/api/settings", { theme: "dark" }, "PUT"));
    assert.equal(extra.status, 400);
  });
});

describe("projects and tools", () => {
  test("creates, lists, and reads a project with its state", async () => {
    const id = await createProject();
    const list = (await (await routes.projects.GET()).json()) as { projects: { id: string; assetCount: number }[] };
    assert.ok(list.projects.some((project) => project.id === id));
    const state = await routes.project.GET(new Request(url(`/api/projects/${id}`)), params({ id }));
    assert.equal(state.status, 200);
    const body = (await state.json()) as { project: { name: string }; targets: object; exports: unknown[]; autoApprove: boolean };
    assert.equal(body.project.name, "Ridgeline bottle, October");
    assert.deepEqual(body.targets, {});
    assert.deepEqual(body.exports, []);

    const missing = await routes.project.GET(new Request(url("/api/projects/x")), params({ id: "not-an-id" }));
    assert.equal(missing.status, 404);
    const unknown = randomUUID();
    assert.equal((await routes.project.GET(new Request(url(`/api/projects/${unknown}`)), params({ id: unknown }))).status, 404);
    const invalid = await routes.projects.POST(json("/api/projects", { name: "" }));
    assert.equal(invalid.status, 400);
  });

  test("runs roster tools, refuses the gate tool and other projects' input", async () => {
    const id = await createProject("Avery tests");
    const brief = { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters", platforms: ["TikTok"], tone: "Warm and direct" };
    const saved = await routes.tools.POST(json(`/api/projects/${id}/tools/save_brief`, { projectId: id, brief }), params({ id, name: "save_brief" }));
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { brief: { tone: string } }).brief.tone, "Warm and direct");

    const gate = await routes.tools.POST(json(`/api/projects/${id}/tools/submit_proposal`, {}), params({ id, name: "submit_proposal" }));
    assert.equal(gate.status, 404);
    const nope = await routes.workspaceTools.POST(json("/api/tools/nope", {}), params({ name: "nope" }));
    assert.equal(nope.status, 404);
    const other = await routes.tools.POST(json(`/api/projects/${id}/tools/save_brief`, { projectId: randomUUID(), brief }), params({ id, name: "save_brief" }));
    assert.equal(other.status, 400);
    const bad = await routes.tools.POST(json(`/api/projects/${id}/tools/save_brief`, { projectId: id }), params({ id, name: "save_brief" }));
    assert.equal(bad.status, 400);

    const recipes = (await (await routes.recipes.GET(new Request(url("/api/recipes?capability=text_to_image")))).json()) as { recipes: { id: string; available: boolean }[] };
    assert.ok(recipes.recipes.some((recipe) => recipe.id === "mock-text-to-image" && recipe.available));
    const library = (await (await routes.library.GET(new Request(url("/api/library")))).json()) as { items: unknown[] };
    assert.deepEqual(library.items, []);
  });
});

describe("generation gate, jobs, and assets", () => {
  test("a mock proposal goes through the gate, jobs finish, and the asset streams with ranges", async () => {
    const id = await createProject("Gate check");
    const proposed = await routes.tools.POST(
      json(`/api/projects/${id}/tools/propose_candidates`, {
        projectId: id,
        capability: "text_to_image",
        recipeId: "mock-text-to-image",
        prompt: "3/4 view headshot of Avery Lane, early 30s, light freckles, soft window light",
        count: 2,
      }),
      params({ id, name: "propose_candidates" }),
    );
    assert.equal(proposed.status, 200);
    const proposal = (await proposed.json()) as { id: string; projectId: string; estimate: { kind: string }; count: number };
    assert.equal(proposal.estimate.kind, "free");

    const otherProject = await createProject("Other");
    const wrong = await routes.submit.POST(json(`/api/projects/${otherProject}/proposals/submit`, { proposal }), params({ id: otherProject }));
    assert.equal(wrong.status, 400);

    const submitted = await routes.submit.POST(json(`/api/projects/${id}/proposals/submit`, { proposal }), params({ id }));
    assert.equal(submitted.status, 200);
    const results = ((await submitted.json()) as { results: { outcome: string }[] }).results;
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => ["started", "existing", "completed"].includes(result.outcome)));

    let assetIds: string[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const jobs = (await (await routes.jobs.GET(new Request(url(`/api/projects/${id}/jobs`)), params({ id }))).json()) as {
        unfinished: unknown[];
        recent: { status: string; outputs?: string[] }[];
      };
      if (jobs.unfinished.length === 0 && jobs.recent.length === 2) {
        assert.ok(jobs.recent.every((job) => job.status === "completed"));
        assetIds = jobs.recent.flatMap((job) => job.outputs ?? []);
        break;
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.equal(assetIds.length, 2, "mock jobs did not finish");

    // Submitting the same proposal again never runs it twice.
    const again = await routes.submit.POST(json(`/api/projects/${id}/proposals/submit`, { proposal }), params({ id }));
    const repeat = ((await again.json()) as { results: { outcome: string }[] }).results;
    assert.ok(repeat.every((result) => result.outcome === "existing"));

    const assetId = assetIds[0];
    const full = await routes.asset.GET(new Request(url(`/api/assets/${assetId}`)), params({ id: assetId }));
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    const size = (await full.arrayBuffer()).byteLength;
    assert.ok(size > 10);
    const partial = await routes.asset.GET(new Request(url(`/api/assets/${assetId}`), { headers: { range: "bytes=0-9" } }), params({ id: assetId }));
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 0-9/${size}`);
    assert.equal((await partial.arrayBuffer()).byteLength, 10);
    const head = await routes.asset.HEAD(new Request(url(`/api/assets/${assetId}`), { method: "HEAD" }), params({ id: assetId }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(size));
    const poster = await routes.asset.GET(new Request(url(`/api/assets/${assetId}?poster`)), params({ id: assetId }));
    assert.equal(poster.status, 404, "stills have no poster");

    const state = (await (await routes.project.GET(new Request(url(`/api/projects/${id}`)), params({ id }))).json()) as {
      targets: Record<string, { kind: string }>;
      recipes: Record<string, string>;
    };
    assert.equal(state.targets[assetId].kind, "loose");
    assert.equal(state.recipes[assetId], "mock-text-to-image");

    const listed = (await (await routes.assets.GET(new Request(url(`/api/assets?projectId=${id}&kind=image`)))).json()) as { assets: { id: string }[] };
    assert.equal(listed.assets.length, 2);

    const archived = await routes.workspaceTools.POST(json("/api/tools/archive_asset", { assetId }), params({ name: "archive_asset" }));
    assert.equal(archived.status, 200);
    const inArchive = (await (await routes.assets.GET(new Request(url("/api/assets?state=archived")))).json()) as { assets: { id: string }[] };
    assert.deepEqual(inArchive.assets.map((asset) => asset.id), [assetId]);

    const usage = await routes.usage.GET(new Request(url(`/api/assets/${assetId}/usage`)), params({ id: assetId }));
    assert.equal(usage.status, 200);
    const usageBody = (await usage.json()) as { usage: unknown[]; affected: string[] };
    assert.equal(usageBody.affected.length, usageBody.usage.length);

    const deleted = await routes.workspaceTools.POST(json("/api/tools/delete_asset_everywhere", { assetId, confirm: true }), params({ name: "delete_asset_everywhere" }));
    assert.equal(deleted.status, 200);
    const gone = await routes.asset.GET(new Request(url(`/api/assets/${assetId}`)), params({ id: assetId }));
    assert.equal(gone.status, 404);
  });
});

describe("chat", () => {
  test("streams assistant events as server-sent events and stores nothing secret", async () => {
    const id = await createProject("Chat check");
    const response = await routes.chat.POST(json(`/api/projects/${id}/chat`, { message: "Hi, I sell the Ridgeline 32 oz bottle." }), params({ id }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const parser = createSseParser();
    const messages = [...parser.push(await response.text()), ...parser.flush()];
    assert.ok(messages.length >= 1);
    const last = JSON.parse(messages.at(-1)!.data) as { type: string; message?: string };
    assert.equal(messages.at(-1)!.event, last.type);
    // No Anthropic key is configured in this workspace, so the turn ends with an error event.
    assert.equal(last.type, "error");

    const history = await routes.chat.GET(new Request(url(`/api/projects/${id}/chat`)), params({ id }));
    assert.equal(history.status, 200);
    const empty = await routes.chat.POST(json(`/api/projects/${id}/chat`, { message: "  " }), params({ id }));
    assert.equal(empty.status, 400);
  });
});
