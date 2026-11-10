/**
 * Backends (v0.2 F6): the list in Settings, the object_info probe, per-recipe availability, and
 * where a proposal runs. The acceptance case: a self-hosted ComfyUI without the LTX nodes shows the
 * LTX recipes unavailable there with the missing node names, and LTX still runs on Comfy Cloud,
 * with the proposal saying so. Every request goes to a fake fetch or a fake SDK client: no network,
 * no credits.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import sharp from "sharp";
import {
  type Backend,
  type ObjectInfo,
  type Recipe,
  type WorkflowRecipe,
  WorkflowGraphSchema,
  compareRequirements,
  defaultWorkflowBackend,
  graphRequirements,
  normalizeBackendUrl,
  placeRecipe,
  recipeStatusOn,
  runsFreeOn,
} from "@creator-lab/core/catalog";
import { type GenerationProposal, type Job, createJob } from "@creator-lab/core/domain/job";
import { compareWorkflowRecipes, fetchObjectInfo, objectInfoRequests, probeBackend } from "@creator-lab/executors/backend-probe";
import { availableRecipes } from "@creator-lab/executors/availability";
import { addBackend, backendRouting, builtInBackends, listBackends, markVerifiedRun, probeAndSave, removeBackend, updateBackend } from "@/server/catalog/backends";
import { defaultRecipes, recipeAvailability, recipesFor } from "@creator-lab/recipes/defaults";
import { createExecutors, legacyClient } from "@creator-lab/executors";
import type { CloudJobHandle, WorkflowClient, WorkflowHandle } from "@creator-lab/executors/workflow";
import { importImage } from "@/server/media/images";
import { callTool, type ToolContext } from "@/server/tools";
import { boundForSubmit } from "@/server/tools/proposals";
import { clock, seedProject, tempStore } from "./support/domain-fixtures";

delete process.env.COMFY_BASE_URL;

const workflowsDir = fileURLToPath(new URL("../packages/recipes/workflows/", import.meta.url));
const LOCAL_NO_LTX: ObjectInfo = JSON.parse(readFileSync(new URL("./fixtures/comfyui/object_info-local-no-ltx.json", import.meta.url), "utf8"));
const KEY = "comfy-test-key-backends-91c2";
const LOCAL_URL = "http://127.0.0.1:8189";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function store() {
  const temp = tempStore();
  cleanups.push(temp.cleanup);
  return temp.store;
}

async function recipes(): Promise<Recipe[]> {
  return defaultRecipes(workflowsDir, { mocks: false });
}

async function workflowRecipe(id: string): Promise<WorkflowRecipe> {
  const recipe = (await recipes()).find((entry) => entry.id === id);
  assert.ok(recipe && recipe.kind === "workflow", id);
  return recipe;
}

/** What Comfy Cloud's object_info looks like for our purposes: every class and model file the starter graphs use. */
async function cloudObjectInfo(): Promise<ObjectInfo> {
  const info: Record<string, { input: { required: Record<string, unknown> } }> = {};
  for (const recipe of await recipes()) {
    if (recipe.kind !== "workflow") continue;
    const graph = WorkflowGraphSchema.parse(JSON.parse(await readFile(join(workflowsDir, recipe.file), "utf8")));
    const needs = graphRequirements(graph);
    for (const name of needs.nodes) info[name] ??= { input: { required: {} } };
    for (const model of needs.models) {
      const required = info[model.classType].input.required;
      const options = (required[model.input] as [string[]] | undefined)?.[0] ?? [];
      required[model.input] = [[...new Set([...options, model.file])]];
    }
  }
  return info;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
  signal: boolean;
}

/** A fetch that answers object_info from a fixture, recording every request. `/api/object_info` 404s unless `api` is set. */
function fakeFetch(info: unknown, options: { api?: boolean; status?: number; body?: string } = {}) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), redirect: init?.redirect, signal: !!init?.signal });
    if (url.endsWith("/api/object_info") && !options.api && !url.startsWith("https://cloud.comfy.org")) return new Response("Not found", { status: 404 });
    if (options.status) return new Response("{}", { status: options.status });
    return new Response(options.body ?? JSON.stringify(info), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, impl };
}

describe("object_info comparison", () => {
  test("a ComfyUI without the LTX nodes lacks every LTX class and model file; Z-Image needs nothing more", async () => {
    const ltx = WorkflowGraphSchema.parse(JSON.parse(await readFile(join(workflowsDir, "ltx-2.5-i2v.api.json"), "utf8")));
    const missing = compareRequirements(graphRequirements(ltx), LOCAL_NO_LTX);
    assert.deepEqual(missing.nodes, [
      "EmptyLTXVLatentVideo",
      "LTXVAudioVAEDecode",
      "LTXVConcatAVLatent",
      "LTXVConditioning",
      "LTXVEmptyLatentAudio",
      "LTXVImgToVideoInplace",
      "LTXVPreprocess",
      "LTXVSeparateAVLatent",
    ]);
    assert.ok(missing.models.includes("ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"), "the UNET loader exists but lists no LTX weights");
    assert.ok(missing.models.includes("ltx-2.5-video-vae-bf16.safetensors"), "VAELoader's newer COMBO shape is read too");
    const zImage = WorkflowGraphSchema.parse(JSON.parse(await readFile(join(workflowsDir, "z-image-turbo-t2i.api.json"), "utf8")));
    assert.deepEqual(compareRequirements(graphRequirements(zImage), LOCAL_NO_LTX), { nodes: [], models: [], partnerNodes: [] });
  });

  test("partner (API) nodes are reported, and a loader that is not a combo is not guessed at", () => {
    const graph = WorkflowGraphSchema.parse({
      "1": { class_type: "GeminiImageNode", inputs: { prompt: "x" } },
      "2": { class_type: "CustomLoader", inputs: { path: "weights.safetensors" } },
    });
    const info: ObjectInfo = { GeminiImageNode: { api_node: true }, CustomLoader: { input: { required: { path: ["STRING", {}] } } } };
    assert.deepEqual(compareRequirements(graphRequirements(graph), info), { nodes: [], models: [], partnerNodes: ["GeminiImageNode"] });
  });
});

describe("backend list", () => {
  test("a blank COMFY_BASE_URL lists Comfy Cloud and Router, with Cloud the workflow default", () => {
    const backends = listBackends(store(), { env: {} });
    assert.deepEqual(backends.map((backend) => [backend.id, backend.kind, backend.baseUrl, backend.builtIn]), [
      ["cloud", "cloud", "https://cloud.comfy.org", true],
      ["router", "router", "https://api.comfy.org", true],
    ]);
    assert.equal(defaultWorkflowBackend(backends)?.id, "cloud");
  });

  test("COMFY_BASE_URL seeds a default entry so an existing install keeps its target, and follows the variable", () => {
    const studio = store();
    const seeded = listBackends(studio, { env: { COMFY_BASE_URL: "http://127.0.0.1:8189/" } });
    assert.deepEqual(seeded.map((backend) => backend.id), ["env", "cloud", "router"]);
    assert.equal(seeded[0].kind, "comfyui");
    assert.equal(seeded[0].baseUrl, LOCAL_URL, "trailing slash dropped");
    assert.equal(defaultWorkflowBackend(seeded)?.id, "env");
    markVerifiedRun(studio, "env", "z-image-turbo-t2i", Date.UTC(2026, 10, 9));
    assert.equal(studio.backends.get("env")?.verified["z-image-turbo-t2i"], "2026-11-09");
    const moved = listBackends(studio, { env: { COMFY_BASE_URL: "https://acme.run.comfy.app" } }).find((backend) => backend.id === "env");
    assert.equal(moved?.kind, "deployment");
    assert.deepEqual(moved?.verified, {}, "a new address starts with no run history");
    assert.deepEqual(listBackends(studio, { env: {} }).map((backend) => backend.id), ["cloud", "router"]);
    assert.deepEqual(builtInBackends({ COMFY_BASE_URL: "https://cloud.comfy.org" }).map((entry) => entry.id), ["cloud", "router"], "Cloud's own URL adds no entry");
  });

  test("addresses are validated: http(s), no credentials, no query", () => {
    assert.deepEqual(normalizeBackendUrl(" http://192.168.1.20:8188/// "), { ok: true, url: "http://192.168.1.20:8188" });
    for (const bad of ["ftp://host", "http://user:pass@host", "http://host/?x=1", "http://host/#a", "not a url", ""]) {
      assert.equal(normalizeBackendUrl(bad).ok, false, bad);
    }
  });

  test("adding, renaming, defaulting and removing; built-ins stay; duplicates and hosted copies are refused", () => {
    const studio = store();
    const added = addBackend(studio, { kind: "comfyui", label: "Studio PC", baseUrl: LOCAL_URL }, { env: {} });
    assert.match(added.id, /^b-[0-9a-f]{8}$/);
    assert.throws(() => addBackend(studio, { kind: "comfyui", label: "Again", baseUrl: LOCAL_URL }, { env: {} }), /already in the list/);
    assert.throws(() => addBackend(studio, { kind: "deployment", label: "Cloud", baseUrl: "https://cloud.comfy.org" }, { env: {} }), /already in the list/);
    assert.throws(() => addBackend(studio, { kind: "comfyui", label: "LAN", baseUrl: "http://10.0.0.5:8188" }, { env: { STUDIO_JUDGE_OPEN: "1" } }), /own studio/);
    assert.deepEqual(
      listBackends(studio, { env: { STUDIO_JUDGE_OPEN: "1" } }).map((backend) => backend.id),
      ["cloud", "router"],
      "a hosted copy ignores added backends even when its data folder has them",
    );
    updateBackend(studio, "cloud", { label: "My Cloud" }, { env: {} });
    assert.equal(listBackends(studio, { env: {} }).find((backend) => backend.id === "cloud")?.label, "My Cloud", "a renamed built-in keeps its name");
    updateBackend(studio, added.id, { default: true, label: "Studio tower" }, { env: {} });
    const listed = listBackends(studio, { env: {} });
    assert.equal(defaultWorkflowBackend(listed)?.label, "Studio tower");
    assert.equal(listed.filter((backend) => backend.default).length, 1);
    assert.throws(() => updateBackend(studio, "router", { default: true }, { env: {} }), /hosted models only/);
    assert.throws(() => removeBackend(studio, "cloud", { env: {} }), /built in/);
    removeBackend(studio, added.id, { env: {} });
    assert.equal(defaultWorkflowBackend(listBackends(studio, { env: {} }))?.id, "cloud", "the default falls back to Cloud");
  });
});

describe("probe", () => {
  test("a self-hosted ComfyUI is read without the key, with no redirects and a timeout; /object_info answers when /api does not", async () => {
    const { calls, impl } = fakeFetch(LOCAL_NO_LTX);
    const info = await fetchObjectInfo({ kind: "comfyui", baseUrl: LOCAL_URL }, { apiKey: KEY, fetch: impl });
    assert.ok(info.KSampler);
    assert.deepEqual(calls.map((call) => call.url), [`${LOCAL_URL}/api/object_info`, `${LOCAL_URL}/object_info`]);
    for (const call of calls) {
      assert.equal(call.redirect, "error");
      assert.ok(call.signal, "every probe request has a timeout");
      assert.ok(!JSON.stringify(call.headers).includes(KEY), "the Comfy key never goes to a self-hosted ComfyUI");
    }
  });

  test("the key goes to Comfy Cloud and to *.comfy.app deployments only", () => {
    assert.equal(objectInfoRequests({ kind: "cloud", baseUrl: "https://cloud.comfy.org" }, KEY)[0].headers["X-API-Key"], KEY);
    assert.equal(objectInfoRequests({ kind: "deployment", baseUrl: "https://acme.run.comfy.app" }, KEY)[0].headers.Authorization, `Bearer ${KEY}`);
    for (const backend of [
      { kind: "deployment" as const, baseUrl: "https://comfy.example.com" },
      { kind: "deployment" as const, baseUrl: "http://acme.run.comfy.app" },
      { kind: "comfyui" as const, baseUrl: "https://studio.comfy.app" },
    ]) {
      assert.ok(!JSON.stringify(objectInfoRequests(backend, KEY)).includes(KEY), backend.baseUrl);
    }
    assert.throws(() => objectInfoRequests({ kind: "cloud", baseUrl: "https://cloud.comfy.org" }, undefined), /needs a Comfy API key/);
  });

  test("failures become readable reasons: refused, not JSON, too large, too slow, no object_info", async () => {
    const backend = { kind: "comfyui" as const, baseUrl: LOCAL_URL };
    await assert.rejects(fetchObjectInfo(backend, { fetch: fakeFetch(null, { status: 401 }).impl }), /refused the request \(HTTP 401\)/);
    await assert.rejects(fetchObjectInfo(backend, { fetch: fakeFetch(null, { body: "<html>" }).impl }), /not JSON/);
    await assert.rejects(fetchObjectInfo(backend, { fetch: fakeFetch(LOCAL_NO_LTX).impl, maxBytes: 1024 }), /more data than/);
    const declared = (async () => new Response("{}", { status: 200, headers: { "content-length": String(10 ** 9) } })) as unknown as typeof fetch;
    await assert.rejects(fetchObjectInfo(backend, { fetch: declared }), /more data than/);
    const slow = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    await assert.rejects(fetchObjectInfo(backend, { fetch: slow, timeoutMs: 5000 }), /did not answer within 5 s/);
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(fetchObjectInfo(backend, { fetch: refused }), /could not be reached/);
    const none = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(fetchObjectInfo(backend, { fetch: none }), /does not publish object_info/);
    await assert.rejects(fetchObjectInfo(backend, { fetch: fakeFetch({}).impl }), /did not answer with a ComfyUI node list/);
  });

  test("a failed probe is saved as a result, not thrown, and leaves recipes not checked", async () => {
    const studio = store();
    const added = addBackend(studio, { kind: "comfyui", label: "Studio PC", baseUrl: LOCAL_URL }, { env: {} });
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const saved = await probeAndSave(studio, added.id, await recipes(), { workflowsDir, fetch: refused, env: {} });
    assert.equal(saved.lastProbe?.ok, false);
    assert.match(saved.lastProbe?.error ?? "", /^Studio PC could not be reached/);
    assert.equal(recipeStatusOn(await workflowRecipe("ltx-2.5-i2v"), saved).status, "unchecked");
  });

  test("Router's probe checks each hosted recipe's model against the live list", async () => {
    const router = listBackends(store(), { env: {} }).find((backend) => backend.id === "router")!;
    const probe = await probeBackend(router, await recipes(), { workflowsDir, routerModels: async () => ["vertexai/gemini-nano-banana-2.1", "kling/kling-v3-omni"] });
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.missing["router-nano-banana-pro-edit"], { nodes: [], models: ["vertexai/gemini-3-pro-image"], partnerNodes: [] });
    assert.equal(probe.missing["router-kling-3-omni-i2v"], undefined);
  });
});

/** A fake SDK client per backend: records submissions and finishes jobs with a real PNG. */
class FakeBackendClient implements WorkflowClient {
  submitted: { graph: Record<string, unknown>; key: string }[] = [];
  constructor(private readonly output: { node: string; png: string } | null) {}
  workflows = {
    fromJson: (graph: Record<string, unknown>): WorkflowHandle => ({
      json: graph,
      setInput(nodeId: string, field: string, value: unknown) {
        (graph[nodeId] as { inputs: Record<string, unknown> }).inputs[field] = value;
      },
    }),
  };
  assets = { fromFile: (path: string) => ({ asset: path }) };
  async submit(workflow: WorkflowHandle, options: { idempotencyKey: string }): Promise<CloudJobHandle> {
    this.submitted.push({ graph: workflow.json, key: options.idempotencyKey });
    return this.handle(`job-${this.submitted.length}`, "queued");
  }
  jobs = { get: async (id: string) => this.handle(id, this.output ? "succeeded" : "running") };
  private handle(id: string, status: string): CloudJobHandle {
    const output = this.output;
    return {
      id,
      status,
      error: null,
      queuePosition: null,
      metrics: { execution_ms: 1000 },
      getOutputs: (node: string) =>
        status === "succeeded" && output && node === output.node
          ? [{ type: "output", contentType: "image/png", toFile: async (path: string) => (await sharp(output.png).toFile(path), path) }]
          : [],
      cancel: async () => undefined,
    };
  }
}

describe("acceptance: a local ComfyUI without the LTX nodes", () => {
  async function setup() {
    const studio = store();
    const now = clock();
    const project = seedProject(studio, now);
    const catalog = await recipes();
    const local = addBackend(studio, { kind: "comfyui", label: "Studio PC", baseUrl: LOCAL_URL }, { env: {} });
    const localFetch = fakeFetch(LOCAL_NO_LTX);
    await probeAndSave(studio, local.id, catalog, { workflowsDir, apiKey: KEY, fetch: localFetch.impl, env: {} });
    await probeAndSave(studio, "cloud", catalog, { workflowsDir, apiKey: KEY, fetch: fakeFetch(await cloudObjectInfo()).impl, env: {} });
    updateBackend(studio, local.id, { default: true }, { env: {} });

    const zImage = await workflowRecipe("z-image-turbo-t2i");
    const png = join(studio.dataDir, "fake-output.png");
    await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toFile(png);
    const clients = { local: new FakeBackendClient({ node: zImage.sidecar.outputNode, png }), cloud: new FakeBackendClient(null) };
    const built: (string | null)[] = [];
    const executors = createExecutors({
      jobs: studio.jobs,
      mediaRoot: studio.dataDir,
      apiKey: KEY,
      workflowsDir,
      backends: () => listBackends(studio, { env: {} }),
      clientFor: (baseUrl, apiKey) => {
        built.push(baseUrl);
        if (baseUrl === LOCAL_URL) assert.equal(apiKey, undefined, "no key for the self-hosted client");
        return baseUrl === null ? clients.cloud : clients.local;
      },
    });
    const context: ToolContext = {
      store: studio,
      now,
      newId: randomUUID,
      generation: {
        executors,
        recipes: async () => catalog,
        routing: () => backendRouting(studio, true, { env: {} }),
        allowanceUsd: () => 5,
        sleep: async () => undefined,
        poster: async () => undefined,
      },
    };
    const reference = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#789" } }).png().toBuffer();
    const still = await importImage(studio, { projectId: project.id, name: "still.png", bytes: reference }, { now: now(), newId: randomUUID });
    const tool = async <T>(name: string, input: unknown): Promise<T> => {
      const result = await callTool(context, name, input);
      assert.ok(result.ok, JSON.stringify(result));
      return result.output as T;
    };
    return { studio, project, local, localFetch, clients, built, tool, still, catalog };
  }

  test("LTX shows unavailable on the local backend with the missing node names, and verified on Cloud", async () => {
    const { studio, local, localFetch } = await setup();
    assert.ok(localFetch.calls.every((call) => !JSON.stringify(call.headers).includes(KEY)));
    const backends = listBackends(studio, { env: {} });
    const saved = backends.find((backend) => backend.id === local.id)!;
    const cloud = backends.find((backend) => backend.id === "cloud")!;
    assert.equal(saved.lastProbe?.nodeClasses, Object.keys(LOCAL_NO_LTX).length);
    for (const id of ["ltx-2.5-i2v", "ltx-2.5-flf2v"]) {
      const status = recipeStatusOn(await workflowRecipe(id), saved);
      assert.equal(status.status, "unavailable", id);
      assert.ok(status.status === "unavailable" && status.nodes.includes("LTXVConditioning") && status.nodes.includes("LTXVPreprocess"), id);
      assert.equal(recipeStatusOn(await workflowRecipe(id), cloud).status, "verified", `${id} still runs on Cloud`);
    }
    const flf = recipeStatusOn(await workflowRecipe("ltx-2.5-flf2v"), saved);
    assert.ok(flf.status === "unavailable" && flf.nodes.includes("LTXVAddGuide"), "the first-and-last graph's own node is named too");
    assert.equal(recipeStatusOn(await workflowRecipe("z-image-turbo-t2i"), saved).status, "compatible");
    assert.equal(recipeStatusOn(await workflowRecipe("wan-2.2-t2v"), saved).status, "unavailable", "Wan's nodes are not on this ComfyUI either");
  });

  test("an LTX clip proposal says it runs on Comfy Cloud and why, and submits there, never to the local backend", async () => {
    const { project, still, clients, tool } = await setup();
    const proposal = await tool<GenerationProposal>("propose_candidates", {
      projectId: project.id,
      capability: "image_to_video",
      recipeId: "ltx-2.5-i2v",
      prompt: "She lifts the bottle and smiles.",
      referenceAssetIds: [still.id],
      count: 1,
    });
    assert.equal(proposal.backendId, "cloud");
    assert.equal(proposal.recipeTitle, "LTX 2.5 image to video on Comfy Cloud");
    assert.match(proposal.estimate.note, /^Runs on Comfy Cloud because Studio PC cannot run it \(missing nodes .*LTXVConditioning/);
    const submitted = await tool<{ results: { outcome: string; job: Job | null }[] }>("submit_proposal", { proposal, confirmUnquoted: true });
    assert.equal(submitted.results[0].outcome, "started", JSON.stringify(submitted.results[0]));
    const recipe = submitted.results[0].job!.request.recipe;
    assert.ok(recipe.kind === "workflow" && recipe.backendId === "cloud", "the job is bound to Cloud, so recovery polls Cloud");
    assert.equal(clients.cloud.submitted.length, 1);
    assert.equal(clients.local.submitted.length, 0);
  });

  test("without a step's recipe named, the starter LTX default still lands on Cloud; with no key it is refused with both reasons", async () => {
    const { studio, project, still, tool } = await setup();
    const proposal = await tool<GenerationProposal>("propose_candidates", { projectId: project.id, capability: "image_to_video", prompt: "A slow push in.", referenceAssetIds: [still.id], count: 1 });
    assert.equal(proposal.recipeId, "ltx-2.5-i2v");
    assert.equal(proposal.backendId, "cloud");
    const ltx = await workflowRecipe("ltx-2.5-i2v");
    assert.equal(placeRecipe(ltx, { backends: [], hasComfyKey: false }).ok, false);
    const placement = placeRecipe(ltx, { backends: listBackends(studio, { env: {} }), hasComfyKey: false });
    assert.ok(!placement.ok && /cannot run on Studio PC: missing nodes .*LTXVConditioning.*, and Comfy Cloud needs a Comfy API key/.test(placement.reason), JSON.stringify(placement));
  });

  test("Z-Image runs on the local backend for free, and a finished run marks it verified there", async () => {
    const { studio, project, local, clients, built, tool } = await setup();
    const proposal = await tool<GenerationProposal>("propose_candidates", { projectId: project.id, capability: "text_to_image", prompt: "A plain studio portrait.", count: 1 });
    assert.equal(proposal.recipeId, "z-image-turbo-t2i");
    assert.equal(proposal.backendId, local.id);
    assert.equal(proposal.recipeTitle, "Z-Image Turbo on Studio PC");
    assert.equal(proposal.estimate.kind, "free");
    assert.equal(proposal.estimate.note, "Runs on Studio PC. Your own ComfyUI: no Comfy credits.", "the backend is named once");
    const submitted = await tool<{ results: { outcome: string; assetIds: string[] }[] }>("submit_proposal", { proposal, wait: true });
    assert.equal(submitted.results[0].outcome, "completed", JSON.stringify(submitted.results[0]));
    assert.equal(submitted.results[0].assetIds.length, 1);
    assert.equal(clients.local.submitted.length, 1);
    assert.equal(clients.cloud.submitted.length, 0);
    assert.ok(built.includes(LOCAL_URL));
    const verified = studio.backends.get(local.id)!.verified["z-image-turbo-t2i"];
    assert.match(verified, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(recipeStatusOn(await workflowRecipe("z-image-turbo-t2i"), studio.backends.get(local.id)!).status, "verified");
  });

  test("a proposal pinned to a backend that lost the recipe is refused at submit instead of moving silently", async () => {
    const { studio, local } = await setup();
    const routing = backendRouting(studio, true, { env: {} });
    const ltx = await workflowRecipe("ltx-2.5-i2v");
    assert.throws(() => boundForSubmit(routing, ltx, local.id), /cannot run on Studio PC: missing nodes .* Propose it again/);
    assert.throws(() => boundForSubmit(routing, ltx, undefined), /Runs on Comfy Cloud because Studio PC cannot run it .* Propose it again/);
    const bound = boundForSubmit(routing, ltx, "cloud");
    assert.ok(bound.kind === "workflow" && bound.backendId === "cloud");
  });

  test("list_recipes and recipesFor read the same availability", async () => {
    const { studio, tool, catalog } = await setup();
    const routing = backendRouting(studio, true, { env: {} });
    const listed = await tool<{ recipes: { id: string; available: boolean; runsOn: string | null; backendNote: string | null }[] }>("list_recipes", { capability: "image_to_video" });
    const ltx = listed.recipes.find((recipe) => recipe.id === "ltx-2.5-i2v")!;
    assert.equal(ltx.available, true);
    assert.equal(ltx.runsOn, "Comfy Cloud");
    assert.match(ltx.backendNote ?? "", /Studio PC cannot run it/);
    assert.ok(recipesFor(catalog, "image_to_video", routing).some((recipe) => recipe.id === "ltx-2.5-i2v"));
    const noKey = { ...routing, hasComfyKey: false };
    assert.ok(!recipesFor(catalog, "image_to_video", noKey).some((recipe) => recipe.id === "ltx-2.5-i2v"), "no backend can run LTX without a key");
    assert.ok(recipesFor(catalog, "text_to_image", noKey).some((recipe) => recipe.id === "z-image-turbo-t2i"), "Z-Image runs on the local ComfyUI with no key");
    const detail = recipeAvailability(catalog, "image_to_video", noKey).find((entry) => entry.recipe.id === "ltx-2.5-i2v")!;
    assert.ok(!detail.placement.ok && /LTXVConditioning/.test(detail.placement.reason));
    assert.equal(recipesFor(catalog, "image_to_video").length, catalog.filter((recipe) => recipe.capability === "image_to_video").length, "without routing nothing is filtered");
  });

  test("model override (F3): the card's selector shows where each recipe runs, and a switch recomputes the backend on the server", async () => {
    const { studio, project, local, still, tool } = await setup();
    type Options = { options: { id: string; fits: boolean; note: string | null }[] };
    const video = await tool<Options>("recipe_options", { projectId: project.id, capability: "image_to_video", references: 1 });
    const ltx = video.options.find((option) => option.id === "ltx-2.5-i2v");
    assert.match(ltx?.note ?? "", /^Runs on Comfy Cloud because Studio PC cannot run it/);
    const stills = await tool<Options>("recipe_options", { projectId: project.id, capability: "text_to_image", references: 0 });
    assert.equal(stills.options.find((option) => option.id === "z-image-turbo-t2i")?.note, "Runs on Studio PC.");

    const noKey = { ...backendRouting(studio, true, { env: {} }), hasComfyKey: false };
    const offeredWithoutKey = availableRecipes(await recipes(), "image_to_video", { executors: { forRecipe: () => undefined }, routerModels: [], routing: noKey });
    assert.ok(!offeredWithoutKey.some(({ recipe }) => recipe.id === "ltx-2.5-i2v"), "a recipe no configured backend can run is not offered");

    const onLocal = await tool<GenerationProposal>("propose_candidates", { projectId: project.id, capability: "text_to_image", prompt: "A plain studio portrait.", count: 1 });
    assert.equal(onLocal.backendId, local.id);
    const hosted = await tool<GenerationProposal>("rerender_proposal", { proposal: onLocal, recipeId: "router-nano-banana-pro-t2i" });
    assert.equal(hosted.backendId, undefined, "a Router recipe carries no workflow backend");
    const back = await tool<GenerationProposal>("rerender_proposal", { proposal: { ...hosted, backendId: "cloud" }, recipeId: "z-image-turbo-t2i" });
    assert.equal(back.backendId, local.id, "the server places it again; a client-sent backendId is ignored");
    assert.equal(back.recipeTitle, "Z-Image Turbo on Studio PC");

    const clip = await tool<GenerationProposal>("propose_candidates", { projectId: project.id, capability: "image_to_video", recipeId: "router-kling-3-omni-i2v", prompt: "A slow push in.", referenceAssetIds: [still.id], count: 1 });
    assert.equal(clip.backendId, undefined);
    const fallback = await tool<GenerationProposal>("rerender_proposal", { proposal: clip, recipeId: "ltx-2.5-i2v" });
    assert.equal(fallback.backendId, "cloud");
    assert.match(fallback.estimate.note, /^Runs on Comfy Cloud because Studio PC cannot run it/);
  });

  test("a backend with a generation in flight cannot be removed", async () => {
    const { studio, project, local, tool } = await setup();
    const proposal = await tool<GenerationProposal>("propose_candidates", { projectId: project.id, capability: "text_to_image", prompt: "A plain studio portrait.", count: 1 });
    const job = await tool<{ results: { job: Job | null }[] }>("submit_proposal", { proposal });
    const unfinished = studio.jobs.get(job.results[0].job!.id)!;
    assert.ok(unfinished.status !== "completed" && unfinished.status !== "failed", unfinished.status);
    assert.throws(() => removeBackend(studio, local.id, { env: {} }), /still running on Studio PC/);
  });
});

/** Placement unit rules over hand-built backends. */
describe("placement", () => {
  const base = { default: false, builtIn: true, lastProbe: null, verified: {}, createdAt: 0, updatedAt: 0 };
  const cloud: Backend = { ...base, id: "cloud", kind: "cloud", label: "Comfy Cloud", baseUrl: "https://cloud.comfy.org" };
  const lan: Backend = { ...base, id: "b-00000001", kind: "comfyui", label: "LAN box", baseUrl: "http://10.0.0.5:8188", default: true, builtIn: false };

  test("an unprobed default backend runs the recipe (as before backends existed); a mock needs no backend", async () => {
    const zImage = await workflowRecipe("z-image-turbo-t2i");
    const placed = placeRecipe(zImage, { backends: [cloud, lan], hasComfyKey: false });
    assert.ok(placed.ok && placed.backend?.id === lan.id && !placed.fallbackFrom);
    assert.equal(recipeStatusOn(zImage, lan).status, "unchecked");
    assert.deepEqual(placeRecipe({ id: "mock-text-to-image", kind: "mock", verified: null, title: "Mock" }, { backends: [], hasComfyKey: false }), { ok: true, backend: null });
  });

  test("Cloud as the default with a probe that lacks the recipe refuses rather than moving elsewhere", async () => {
    const zImage = await workflowRecipe("z-image-turbo-t2i");
    const probed: Backend = { ...cloud, lastProbe: { at: 1, ok: true, nodeClasses: 1, checked: [zImage.id], missing: { [zImage.id]: { nodes: ["KSampler"], models: [], partnerNodes: [] } } } };
    const placed = placeRecipe(zImage, { backends: [probed, { ...lan, default: false }], hasComfyKey: true });
    assert.ok(!placed.ok && /cannot run on Comfy Cloud: missing node KSampler/.test(placed.reason));
  });
});

describe("QA fixes", () => {
  test("a partner (API) node rules a recipe out on a self-hosted backend, with the reason, but not on Cloud", async () => {
    const zImage = await workflowRecipe("z-image-turbo-t2i");
    // The graph is unchanged; only the backend flags its sampler as a partner node.
    const flagged: ObjectInfo = { ...LOCAL_NO_LTX, KSampler: { ...LOCAL_NO_LTX.KSampler, api_node: true } };
    const local = await compareWorkflowRecipes([zImage], flagged, workflowsDir, true);
    assert.deepEqual(local.missing[zImage.id], { nodes: [], models: [], partnerNodes: ["KSampler"] });
    const cloud = await compareWorkflowRecipes([zImage], flagged, workflowsDir, false);
    assert.equal(cloud.missing[zImage.id], undefined, "on Cloud a partner node bills the key under the budget, so it stays allowed");

    const studio = store();
    const added = addBackend(studio, { kind: "comfyui", label: "Studio PC", baseUrl: LOCAL_URL }, { env: {} });
    const saved = await probeAndSave(studio, added.id, [zImage], { workflowsDir, fetch: fakeFetch(flagged).impl, env: {} });
    assert.equal(recipeStatusOn(zImage, saved).status, "unavailable");
    assert.equal(runsFreeOn(zImage.id, saved), false);
    updateBackend(studio, added.id, { default: true }, { env: {} });
    const placement = placeRecipe(zImage, backendRouting(studio, false, { env: {} }));
    assert.ok(!placement.ok && /uses partner node KSampler, which bills the Comfy account signed in there/.test(placement.reason), JSON.stringify(placement));
  });

  test("a self-hosted run is free only after a probe cleared the recipe; unprobed, it reserves the ceiling", async () => {
    const studio = store();
    const added = addBackend(studio, { kind: "comfyui", label: "Studio PC", baseUrl: LOCAL_URL }, { env: {} });
    const zImage = await workflowRecipe("z-image-turbo-t2i");
    const executors = createExecutors({
      jobs: studio.jobs,
      mediaRoot: studio.dataDir,
      workflowsDir,
      backends: () => listBackends(studio, { env: {} }),
      clientFor: () => new FakeBackendClient(null),
    });
    const bound = { ...zImage, backendId: added.id };
    const estimate = () => executors.forRecipe(bound)!.estimate({ requestId: randomUUID(), projectId: randomUUID(), recipe: bound, input: { prompt: "A portrait.", images: [] } });
    assert.equal((await estimate()).kind, "quoted", "unprobed: a partner node could be in the graph, so the ceiling is reserved");
    await probeAndSave(studio, added.id, [zImage], { workflowsDir, fetch: fakeFetch(LOCAL_NO_LTX).impl, env: {} });
    assert.equal((await estimate()).kind, "free");
  });

  test("the COMFY_BASE_URL entry keeps its address while jobs bound to it are unfinished", async () => {
    const studio = store();
    const now = clock();
    const project = seedProject(studio, now);
    listBackends(studio, { env: { COMFY_BASE_URL: LOCAL_URL } });
    const recipe = { ...(await workflowRecipe("z-image-turbo-t2i")), backendId: "env" };
    studio.jobs.add(createJob({ id: randomUUID(), requestId: randomUUID(), projectId: project.id, request: { recipe, input: { prompt: "x", images: [] } } }, now()));
    const moved = listBackends(studio, { env: { COMFY_BASE_URL: "http://127.0.0.1:9999" } }).find((backend) => backend.id === "env");
    assert.equal(moved?.baseUrl, LOCAL_URL, "the in-flight job still polls the server it was sent to");
    assert.ok(listBackends(studio, { env: {} }).some((backend) => backend.id === "env"), "nor is it removed while the job runs");
  });

  test("the legacy client (jobs saved before backends) sends the key only to Cloud or a Comfy host", () => {
    const built: [string | null, string | undefined][] = [];
    const build = (baseUrl: string | null, apiKey: string | undefined) => {
      built.push([baseUrl, apiKey]);
      return new FakeBackendClient(null);
    };
    legacyClient(KEY, {}, build);
    legacyClient(KEY, { COMFY_BASE_URL: "http://127.0.0.1:8189/" }, build);
    legacyClient(KEY, { COMFY_BASE_URL: "https://acme.run.comfy.app" }, build);
    legacyClient(KEY, { COMFY_BASE_URL: "https://cloud.comfy.org" }, build);
    assert.equal(legacyClient(undefined, {}, build), undefined, "no key and no address: no client");
    assert.deepEqual(built, [
      [null, KEY],
      [LOCAL_URL, undefined],
      ["https://acme.run.comfy.app", KEY],
      [null, KEY],
    ]);
  });
});
