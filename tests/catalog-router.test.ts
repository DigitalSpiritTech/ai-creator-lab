/**
 * Router catalog: capability tagging from recorded schemas, and the listing and schema cache.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RouterCatalog, type CatalogPort } from "@/server/catalog/router-catalog";
import { imageFields, tagModel } from "@/server/catalog/tagging";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/router/${name}`, import.meta.url), "utf8"));
const catalog = fixture("catalog.json");
const schemas: Record<string, { etag: string; document: unknown }> = {
  "vertexai/gemini-nano-banana-2.1": fixture("schema-vertexai__gemini-nano-banana-2.1.json"),
  "ltx/ltx-2-5-fast": fixture("schema-ltx__ltx-2-5-fast.json"),
  "anthropic/claude-opus-5-5": fixture("schema-anthropic__claude-opus-5-5.json"),
};

test("recorded schemas tag to the expected capabilities", () => {
  const nano = tagModel("vertexai/gemini-nano-banana-2.1", schemas["vertexai/gemini-nano-banana-2.1"].document);
  assert.deepEqual(nano.capabilities, ["text_to_image", "image_edit"]);
  assert.equal(nano.curated, true);
  assert.equal(nano.maxReferences, 14);
  assert.deepEqual(nano.inputs, ["text", "image", "video"]);

  const ltx = tagModel("ltx/ltx-2-5-fast", schemas["ltx/ltx-2-5-fast"].document);
  assert.deepEqual(ltx.capabilities, ["text_to_video"]);
  const heuristicLtx = tagModel("ltx/some-new-model", schemas["ltx/ltx-2-5-fast"].document);
  assert.deepEqual(heuristicLtx.capabilities, ["text_to_video"], "the heuristic agrees with the override for LTX");
  assert.equal(heuristicLtx.curated, false);

  const claude = tagModel("anthropic/claude-opus-5-5", schemas["anthropic/claude-opus-5-5"].document);
  assert.deepEqual(claude.capabilities, ["text_generation"]);
  assert.equal(claude.curated, false);

  const heuristicNano = tagModel("vertexai/unlisted", schemas["vertexai/gemini-nano-banana-2.1"].document);
  assert.deepEqual(heuristicNano.capabilities, ["text_to_image", "image_edit"]);
  assert.equal(heuristicNano.maxReferences, undefined, "the reference limit only comes from the override");
});

test("heuristics read frame and reference fields, including enum values and $refs", () => {
  const document = {
    "x-comfy-router-input-modalities": ["text", "image"],
    "x-comfy-router-output-modalities": ["video"],
    paths: {
      "/v2/models/acme/video": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                    media: { type: "array", items: { $ref: "#/components/schemas/Media" } },
                    reference_images: { type: "array", maxItems: 4, items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Media: { type: "object", properties: { type: { type: "string", enum: ["first_frame", "last_frame"] }, url: { type: "string" } } } } },
  };
  const found = imageFields(document);
  assert.ok(found.fields.includes("media.type=first_frame"));
  assert.ok(found.fields.includes("media.type=last_frame"));
  assert.equal(found.maxReferences, 4);
  assert.deepEqual(tagModel("acme/video", document).capabilities, ["text_to_video", "image_to_video", "first_last_to_video", "references_to_video"]);
  const image = { ...document, "x-comfy-router-output-modalities": ["image"] };
  assert.deepEqual(tagModel("acme/image", image).capabilities, ["text_to_image", "image_edit"]);
});

function fakePort() {
  const calls = { list: 0, schema: [] as { id: string; etag: string | null | undefined }[] };
  let failing = false;
  const port: CatalogPort & { calls: typeof calls; fail(value: boolean): void } = {
    calls,
    fail(value) {
      failing = value;
    },
    list() {
      calls.list++;
      return (async function* () {
        if (failing) throw new Error("offline");
        yield* catalog.data;
      })();
    },
    async schema(id, options) {
      calls.schema.push({ id, etag: options?.etag });
      if (failing) throw new Error("offline");
      const entry = schemas[id];
      if (!entry) throw new Error("no fixture");
      if (options?.etag === entry.etag) return { unchanged: true, document: undefined, etag: entry.etag };
      return { unchanged: false, document: entry.document, etag: entry.etag };
    },
  };
  return port;
}

test("the catalog lists every model once, caches the listing, and refreshes on request", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acl-router-catalog-"));
  try {
    let clock = 1_000;
    const port = fakePort();
    const router = new RouterCatalog({ port, dataDir, now: () => clock });
    const models = await router.models();
    assert.equal(models.length, 262);
    assert.equal(new Set(models.map((model) => model.id)).size, 262);
    const ltx = models.find((model) => model.id === "ltx/ltx-2-5-fast")!;
    assert.equal(ltx.chargesOnPolicyRejection, false);
    assert.equal(ltx.schemaEtag, schemas["ltx/ltx-2-5-fast"].etag);
    await router.models();
    assert.equal(port.calls.list, 1);
    clock += 7 * 60 * 60 * 1000;
    await router.models();
    assert.equal(port.calls.list, 2);
    port.fail(true);
    assert.equal((await router.models({ refresh: true })).length, 262, "a failed refresh keeps the cached listing");
    const cached = JSON.parse(await readFile(join(dataDir, "catalog", "router-models.json"), "utf8"));
    assert.equal(cached.models.length, 262);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("schemas are cached by ETag and served without a request while the listing's ETag matches", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acl-router-schema-"));
  try {
    const port = fakePort();
    const router = new RouterCatalog({ port, dataDir });
    await router.models();
    const first = await router.schema("ltx/ltx-2-5-fast");
    assert.deepEqual(first, schemas["ltx/ltx-2-5-fast"].document);
    assert.deepEqual(port.calls.schema, [{ id: "ltx/ltx-2-5-fast", etag: null }]);
    await router.schema("ltx/ltx-2-5-fast");
    assert.equal(port.calls.schema.length, 1, "matching listing ETag means no request");
    assert.deepEqual(await router.schema("ltx/ltx-2-5-fast", { refresh: true }), first);
    assert.deepEqual(port.calls.schema[1], { id: "ltx/ltx-2-5-fast", etag: schemas["ltx/ltx-2-5-fast"].etag });
    port.fail(true);
    assert.deepEqual(await router.schema("ltx/ltx-2-5-fast", { refresh: true }), first, "offline falls back to the cached copy");
    await assert.rejects(router.schema("anthropic/claude-opus-5-5"), /offline/);
    port.fail(false);
    await router.schema("vertexai/gemini-nano-banana-2.1");
    assert.deepEqual((await router.byCapability("text_to_video")).map((model) => model.id), ["ltx/ltx-2-5-fast"]);
    assert.deepEqual((await router.byCapability("image_edit")).map((model) => model.id), ["vertexai/gemini-nano-banana-2.1"]);
    assert.equal(await router.cachedSchema("anthropic/claude-opus-5-5"), undefined);
    await assert.rejects(router.schema("../etc/passwd"), /Unknown Router model id/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
