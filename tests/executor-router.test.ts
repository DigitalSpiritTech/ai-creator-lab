/**
 * Router executor with a fake `comfy.models` port, recorded result shapes, and the model schemas
 * recorded from api.comfy.org on October 26. No network, no credits.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ComfyError, type RunResult } from "@comfyorg/sdk";
import sharp from "sharp";
import { checkAgainstSchema, requestBodySchema, type Recipe, type RouterRecipe } from "@/lib/catalog";
import { ROUTER_RECIPES } from "@/server/catalog/defaults";
import { MemoryJobStore, admitJob } from "./support/memory-job-store";
import { buildRouterBody, prepareImages } from "@/server/executors/router-body";
import { downloadMedia, mediaRequestOptions, mediaUrl, publicMediaAddress, type MediaPorts } from "@/server/executors/router-download";
import { extractRouterMedia } from "@/server/executors/router-output";
import { classifyRouterError, parseCredits, RouterExecutor, type RouterModelsPort } from "@/server/executors/router";
import type { GenerationInput, Job } from "@/server/executors/types";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/router/${name}`, import.meta.url), "utf8"));
const results = fixture("results.json");
const nanoSchema = fixture("schema-vertexai__gemini-nano-banana-2.1.json").document;
const ltxSchema = fixture("schema-ltx__ltx-2-5-fast.json").document;

function routerRecipe(id: string): RouterRecipe {
  const recipe = ROUTER_RECIPES.find((entry) => entry.id === id);
  assert.ok(recipe, id);
  return recipe;
}

function request(jobs: MemoryJobStore, recipe: Recipe, input: Partial<GenerationInput> & { prompt: string }): Job {
  return admitJob(jobs, { recipe, input });
}

function json(data: unknown, extra: Partial<RunResult> = {}): RunResult {
  return { kind: "json", data, requestId: "req-1", servingProvider: null, droppedParams: null, replayed: false, creditsUsed: "13", ...extra } as RunResult;
}

/** Fake `comfy.models`: records every call and answers from a script. */
function fakeModels(answer: (call: number, key: string) => RunResult | Error): RouterModelsPort & { calls: { model: string; body: Record<string, unknown>; key: string }[] } {
  const calls: { model: string; body: Record<string, unknown>; key: string }[] = [];
  return {
    calls,
    async run(model, body, options) {
      calls.push({ model, body, key: options!.idempotencyKey! });
      const result = answer(calls.length, options!.idempotencyKey!);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** Public DNS and a CDN that serves fixed bytes; no credentials ever reach it. */
function cdn(bytes: Uint8Array, gets: string[] = []): MediaPorts {
  return {
    async lookup() {
      return [{ address: "8.8.8.8", family: 4 }];
    },
    async get(url) {
      gets.push(url.hostname);
      return new Response(new Uint8Array(bytes));
    },
  };
}

async function withTemp<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "acl-router-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function png(path: string, width: number, height: number): Promise<string> {
  await sharp({ create: { width, height, channels: 3, background: "#33664d" } }).png().toFile(path);
  return path;
}

test("the Nano Banana body matches the verified spike shape and the recorded schema", () =>
  withTemp(async (directory) => {
    const recipe = routerRecipe("router-nano-banana-2.1-edit");
    const face = await png(join(directory, "face.png"), 64, 64);
    const product = await png(join(directory, "product.png"), 48, 64);
    const images = await prepareImages([face, product], recipe);
    const body = buildRouterBody(recipe, { prompt: "Place the woman from image 1 at a kitchen counter.", images: [face, product], aspectRatio: "9:16" }, images);
    assert.deepEqual(body, {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Place the woman from image 1 at a kitchen counter." },
            { inlineData: { mimeType: "image/png", data: images[0].base64 } },
            { inlineData: { mimeType: "image/png", data: images[1].base64 } },
          ],
        },
      ],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16", imageSize: "1K", imageOutputOptions: { mimeType: "image/png" } } },
      uploadImagesToStorage: true,
    });
    assert.deepEqual(checkAgainstSchema(body, requestBodySchema(nanoSchema)!, nanoSchema), []);
    assert.throws(() => buildRouterBody(recipe, { prompt: "No references", images: [] }, []), /at least 1 reference image/);
  }));

test("the LTX Fast body fits its recorded schema, and the checker catches values outside it", () => {
  const recipe = routerRecipe("router-ltx-2.5-fast");
  const body = buildRouterBody(recipe, { prompt: "A bottle on a counter, morning light.", images: [], aspectRatio: "16:9", durationSeconds: 6 }, []);
  assert.deepEqual(body, { generate_audio: true, fps: 24, prompt: "A bottle on a counter, morning light.", resolution: "1920x1080", duration: 6 });
  const schema = requestBodySchema(ltxSchema)!;
  assert.deepEqual(checkAgainstSchema(body, schema, ltxSchema), []);
  assert.match(checkAgainstSchema({ ...body, resolution: "500x500" }, schema, ltxSchema).join(" "), /resolution must be one of/);
  assert.match(checkAgainstSchema({ prompt: "x" }, schema, ltxSchema).join(" "), /duration is required/);
  assert.throws(() => buildRouterBody(recipe, { prompt: "x", images: [], durationSeconds: 7 }, []), /2, 3, 4, 5, 6, 8, 10 seconds/);
  assert.throws(() => buildRouterBody(recipe, { prompt: "x", images: [], aspectRatio: "1:1" }, []), /does not offer 1:1/);
});

test("submit records the request id and credits, then retrieve downloads and verifies the still", () =>
  withTemp(async (directory) => {
    const repository = new MemoryJobStore();
    const recipe = routerRecipe("router-nano-banana-2.1-edit");
    const face = await png(join(directory, "face.png"), 64, 64);
    const output = await sharp({ create: { width: 768, height: 1376, channels: 3, background: "#ddeeff" } }).png().toBuffer();
    const gets: string[] = [];
    const models = fakeModels(() => json(results.gemini_file, { requestId: "d52907a3-4341-4c26-9bc6-c77bd36eac54", creditsUsed: "12.5" }));
    const executor = new RouterExecutor({ jobs: repository, models, mediaPorts: cdn(output, gets), schemaFor: async () => nanoSchema });
    const submitted = await executor.submit(request(repository, recipe, { prompt: "Compose the two references.", images: [face], aspectRatio: "9:16" }));
    assert.equal(submitted.kind, "accepted");
    const job = submitted.job!;
    assert.equal(job.status, "retrieving");
    assert.equal(job.providerRef, "d52907a3-4341-4c26-9bc6-c77bd36eac54");
    assert.equal(job.creditsUsed, 12.5);
    assert.equal(models.calls[0].key, job.id);
    assert.equal(models.calls[0].model, "vertexai/gemini-nano-banana-2.1");
    assert.equal((await executor.poll(job.id)).kind, "ready");
    const retrieved = await executor.retrieve(job.id, { root: directory, folder: "media" });
    assert.equal(retrieved.kind, "completed");
    assert.deepEqual(gets, ["storage.googleapis.com"]);
    const [saved] = repository.get(job.id)!.retrieved;
    assert.deepEqual([saved.mime, saved.width, saved.height], ["image/png", 768, 1376]);
    assert.deepEqual(await readFile(join(directory, saved.relativePath)), output);
    assert.equal(models.calls.length, 1);
  }));

test("a schema violation is rejected before anything is sent", () =>
  withTemp(async () => {
    const models = fakeModels(() => json(results.ltx));
    const repository = new MemoryJobStore();
    const executor = new RouterExecutor({ jobs: repository, models, schemaFor: async () => ltxSchema });
    const recipe = { ...routerRecipe("router-ltx-2.5-fast"), limits: {}, fieldMap: { ...routerRecipe("router-ltx-2.5-fast").fieldMap, template: { fps: 30 } } };
    const outcome = await executor.submit(request(repository, recipe, { prompt: "x", images: [], durationSeconds: 5 }));
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.kind === "failed" ? outcome.error.message : "", /fps must be one of 24, 25, 48, 50/);
    assert.equal(models.calls.length, 0);
  }));

test("content policy refusals become per-candidate provider failures with the reason", () =>
  withTemp(async (directory) => {
    const face = await png(join(directory, "face.png"), 64, 64);
    const recipe = routerRecipe("router-nano-banana-2.1-edit");
    const refused = new ComfyError("Request blocked by the provider's safety filter.", { code: "content_policy_violation", httpStatus: 400, requestId: "req-9" });
    const repository = new MemoryJobStore();
    const viaError = await new RouterExecutor({ jobs: repository, models: fakeModels(() => refused) }).submit(request(repository, recipe, { prompt: "x", images: [face] }));
    assert.equal(viaError.kind, "failed");
    if (viaError.kind !== "failed") return;
    assert.equal(viaError.error.code, "provider");
    assert.equal(viaError.error.providerCode, "content_policy_violation");
    assert.match(viaError.error.message, /safety filter/);
    assert.equal(viaError.job?.status, "failed");

    const viaBody = await new RouterExecutor({ jobs: repository, models: fakeModels(() => json(results.gemini_blocked)) }).submit(request(repository, recipe, { prompt: "y", images: [face] }));
    assert.equal(viaBody.kind, "failed");
    if (viaBody.kind !== "failed") return;
    assert.equal(viaBody.error.providerCode, "content_policy_violation");
    assert.match(viaBody.error.message, /safety policy/);
    assert.equal(viaBody.job?.creditsUsed, 13);
  }));

test("a lost response is uncertain, collected under the same key, and replayed after a restart", () =>
  withTemp(async (directory) => {
    const repository = new MemoryJobStore();
    const recipe = routerRecipe("router-ltx-2.5-fast");
    const clip = Buffer.from("not a real mp4");
    let clock = 10_000_000;
    const models = fakeModels((call) => (call === 1 ? new TypeError("fetch failed") : json(results.ltx, { replayed: call > 2 })));
    const first = new RouterExecutor({ jobs: repository, models, mediaPorts: cdn(clip), now: () => clock });
    const submitted = await first.submit(admitJob(repository, { recipe, input: { prompt: "A bottle on a counter." } }, clock));
    assert.equal(submitted.kind, "uncertain");
    const job = submitted.job!;
    assert.match(job.notice!, /never charged twice/);
    assert.equal((await first.poll(job.id)).kind, "ready");
    assert.equal(models.calls.length, 2);

    const restarted = new RouterExecutor({ jobs: repository, models, mediaPorts: cdn(clip), now: () => clock });
    const retrieved = await restarted.retrieve(job.id, { root: directory, folder: "clips" });
    assert.equal(models.calls.length, 3);
    assert.deepEqual(new Set(models.calls.map((call) => call.key)), new Set([job.id]));
    assert.deepEqual(models.calls[0].body, models.calls[2].body);
    assert.equal(retrieved.kind, "retry");
    assert.match(retrieved.kind === "retry" ? retrieved.error.message : "", /could not be decoded/);
    assert.deepEqual(await readdir(join(directory, "clips")), []);

    clock += 25 * 60 * 60 * 1000;
    const expired = await restarted.retrieve(job.id, { root: directory, folder: "clips" });
    assert.equal(expired.kind, "failed");
    assert.match(expired.kind === "failed" ? expired.error.message : "", /24-hour/);
  }));

test("each model family's result shape yields its media, and moderated results are refusals", () => {
  const url = (family: Parameters<typeof extractRouterMedia>[0], data: unknown) => {
    const media = extractRouterMedia(family, { kind: "json", data });
    assert.equal(media.kind, "url");
    return media.kind === "url" ? new URL(media.url).hostname : "";
  };
  assert.equal(url("gemini", results.gemini_file), "storage.googleapis.com");
  assert.equal(url("flux", results.flux), "delivery-eu1.bfl.ai");
  assert.equal(url("minimax", results.minimax), "cdn.minimax-video.com");
  assert.equal(url("wan", results.wan), "dashscope-463f.oss-accelerate.aliyuncs.com");
  assert.equal(url("kling", results.kling), "cdn.klingai.com");
  assert.equal(url("seedance", results.seedance), "ark-content-generation.bytepluses.com");
  assert.equal(url("ltx", results.ltx), "storage.ltx.video");
  const inline = extractRouterMedia("gemini", { kind: "json", data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] } }] } });
  assert.equal(inline.kind, "inline");
  assert.throws(() => extractRouterMedia("ltx", { kind: "json", data: results.ltx_moderated }), /declined this request: The prompt was flagged/);
  assert.throws(() => extractRouterMedia("wan", { kind: "json", data: { output: { task_status: "FAILED", message: "Timed out" } } }), /failed generation: Timed out/);
  assert.throws(() => extractRouterMedia("flux", { kind: "json", data: { surprise: true } }), /recognizable output/);
  assert.equal(extractRouterMedia(undefined, { kind: "binary", data: new Uint8Array([1]), contentType: "audio/mpeg" }).kind, "inline");
});

test("Router errors map to terminal failures or uncertain submissions", () => {
  const error = (code: string, httpStatus: number) => new ComfyError(`${code} happened`, { code, httpStatus });
  const failed = (cause: unknown) => {
    const classified = classifyRouterError(cause);
    assert.equal(classified.outcome, "failed");
    return classified.outcome === "failed" ? classified.error : undefined;
  };
  assert.equal(failed(error("invalid_input", 422))?.code, "invalid");
  assert.equal(failed(error("insufficient_credits", 402))?.code, "budget");
  assert.equal(failed(error("not_enabled", 403))?.providerCode, "not_enabled");
  assert.equal(failed(error("model_not_found", 404))?.code, "provider");
  assert.equal(failed(error("rate_limited", 429))?.retryable, true);
  for (const cause of [error("deadline_exceeded", 504), error("service_unavailable", 503), error("concurrency_limit_exceeded", 409), new TypeError("fetch failed")]) {
    assert.equal(classifyRouterError(cause).outcome, "uncertain");
  }
  assert.equal(parseCredits("12.5"), 12.5);
  assert.equal(parseCredits("0"), 0);
  assert.equal(parseCredits(null), null);
  assert.equal(parseCredits("12.5, 3"), null);
});

test("media policy allows changing CDN names and rejects non-public address ranges and unsafe URL forms", () => {
  for (const address of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) {
    assert.equal(publicMediaAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(publicMediaAddress(address), true, address);
  for (const url of ["https://127.1/a", "https://[::1]/a", "https://localhost/a", "https://video.local/a", "https://metadata.google.internal/a", "http://cdn.example.com/a", "file:///etc/passwd", "https://cdn.example.com:8443/a", "https://user:pass@cdn.example.com/a", "https://cdn.example.com/a#fragment"]) {
    assert.throws(() => mediaUrl(url), url);
  }
  assert.equal(mediaUrl("https://new-provider-cdn.example.com/video.mp4?signature=opaque").hostname, "new-provider-cdn.example.com");
});

test("media downloads recheck redirects, pin the checked address, and never leak signed URLs", async () => {
  let lookups = 0;
  let redirect = true;
  let mode: "ok" | "oversize" | "throw" = "ok";
  const ports: MediaPorts = {
    async lookup() {
      lookups++;
      return [{ address: lookups > 1 && redirect ? "127.0.0.1" : "8.8.8.8", family: 4 }];
    },
    async get(url, address, signal) {
      assert.equal(address.address, "8.8.8.8");
      const options = mediaRequestOptions(url, address, signal);
      assert.equal(options.servername, url.hostname);
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.headers, undefined);
      if (mode === "throw") throw new Error("https://secret.example.com/?private=signed-token");
      if (mode === "oversize") return new Response(new Uint8Array(1), { headers: { "content-length": String(300 * 1024 * 1024) } });
      return redirect ? new Response(null, { status: 302, headers: { location: "https://another-cdn.example.com/v.mp4" } }) : new Response(new Uint8Array([1, 2, 3]));
    },
  };
  await assert.rejects(downloadMedia("https://first-cdn.example.com/v.mp4?sig=private", ports), /not a public HTTPS destination/);
  assert.equal(lookups, 2);
  redirect = false;
  assert.deepEqual([...(await downloadMedia("https://cdn.example.com/a", ports))], [1, 2, 3]);
  mode = "oversize";
  await assert.rejects(downloadMedia("https://cdn.example.com/a", ports), /download limit/);
  mode = "throw";
  await assert.rejects(downloadMedia("https://cdn.example.com/a", ports), (error: unknown) => {
    assert.equal(JSON.stringify(error).includes("signed-token"), false);
    assert.equal(String(error).includes("signed-token"), false);
    return true;
  });
});
