/**
 * Router adapters: a model id becomes one recipe per capability with a body the provider's schema
 * shape expects, and unknown providers get no adapter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { adapterFor, adapterRecipes } from "@/server/catalog/router-adapters";
import { buildRouterBody } from "@/server/executors/router-body";

const png = { base64: "AAAA", mime: "image/png" };

test("families are matched by provider and name; unknown providers have no adapter", () => {
  assert.equal(adapterFor("bfl/flux-2-pro")?.info.family, "FLUX (BFL)");
  assert.equal(adapterFor("kling/kling-v3-omni")?.info.family, "Kling omni video");
  assert.equal(adapterFor("kling/kling-v3")?.info.family, "Kling text video");
  assert.equal(adapterFor("byteplus/seedance-1-5-pro-251215")?.info.family, "Seedance");
  assert.equal(adapterFor("minimax/minimax-h3")?.info.family, "MiniMax video");
  assert.equal(adapterFor("openai/gpt-image-2")?.info.family, "OpenAI image");
  assert.equal(adapterFor("vertexai/gemini-3-pro-image")?.info.family, "Gemini image");
  assert.equal(adapterFor("veo/veo-3.1-generate-001"), null);
  assert.equal(adapterFor("openai/gpt-5"), null);
  assert.equal(adapterFor("bfl/flux-3-video"), null);
  assert.equal(adapterFor("bfl/vto-v1"), null, "virtual try-on has its own request shape");
});

test("enabled models expand to recipes with stable ids, and the bodies follow each provider's shape", () => {
  const recipes = adapterRecipes(["bfl/flux-2-pro", "byteplus/seedance-1-5-pro-251215", "kling/kling-image-o1", "nope/unknown"]);
  assert.deepEqual(
    recipes.map((recipe) => recipe.id),
    ["router-bfl-flux-2-pro-text-to-image", "router-bfl-flux-2-pro-image-edit", "router-byteplus-seedance-1-5-pro-251215-text-to-video", "router-byteplus-seedance-1-5-pro-251215-image-to-video", "router-byteplus-seedance-1-5-pro-251215-first-last-to-video", "router-kling-kling-image-o1-text-to-image", "router-kling-kling-image-o1-image-edit"],
  );
  const flux = recipes.find((recipe) => recipe.id === "router-bfl-flux-2-pro-image-edit")!;
  const fluxBody = buildRouterBody(flux, { prompt: "p", images: ["a", "b"], aspectRatio: "9:16", seed: 7 }, [png, png]);
  assert.deepEqual(fluxBody, { output_format: "png", prompt_upsampling: false, prompt: "p", input_image: "AAAA", input_image_2: "AAAA", width: 768, height: 1376, seed: 7 });
  const seedance = recipes.find((recipe) => recipe.id === "router-byteplus-seedance-1-5-pro-251215-first-last-to-video")!;
  const seedanceBody = buildRouterBody(seedance, { prompt: "p", images: ["a", "b"], aspectRatio: "9:16", durationSeconds: 5 }, [png, png]) as { content: unknown[] };
  assert.deepEqual(seedanceBody.content, [
    { type: "text", text: "p" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" }, role: "first_frame" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" }, role: "last_frame" },
  ]);
  assert.equal((seedanceBody as unknown as { duration: number }).duration, 5);
  const klingImage = recipes.find((recipe) => recipe.id === "router-kling-kling-image-o1-text-to-image")!;
  assert.deepEqual(buildRouterBody(klingImage, { prompt: "p", images: [], aspectRatio: "3:4" }, []), { resolution: "1k", n: 1, result_type: "single", prompt: "p", aspect_ratio: "3:4" });
  assert.throws(() => buildRouterBody(flux, { prompt: "p", images: Array(10).fill("x"), aspectRatio: "1:1" }, Array(10).fill(png)), /at most 9 reference images/);
});
