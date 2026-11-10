/**
 * The Krea 2 face-lock variant: sentences for its Qwen3-VL text encoder, the same content as the
 * standard prompt, chosen by recipe id. The standard (Z-Image) prompt is snapshotted unchanged in
 * agent-prompts.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROMPT_LIMIT, backdropOf, faceLockPrompt, facePrompt, kreaFacePrompt } from "@creator-lab/recipes/prompts";
import { averyBible } from "./support/domain-fixtures";

const EXPECTED = {
  krea:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. This is a photographic head-and-shoulders portrait of the person wearing a plain fitted navy crew-neck top. The head is turned about thirty degrees to the left, so the far cheek narrows, the near ear shows, and the nose sits just off the center of the face, while the eyes look back toward the camera. The expression is neutral with a hint of a smile. Soft natural window light falls across the face, and behind the person is a deep neutral gray (#3a3a3c) seamless background. There are no accessories beyond those described. It looks like an 85mm portrait photograph, with natural skin texture and sharp focus on the eyes. The outfit must contrast clearly with the background so the silhouette reads. No text, captions, logos, or watermarks in the image.",
  kreaDarkGarment:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. This is a photographic head-and-shoulders portrait of the person wearing a heather gray hoodie. The head is turned about thirty degrees to the left, so the far cheek narrows, the near ear shows, and the nose sits just off the center of the face, while the eyes look back toward the camera. The expression is neutral with a hint of a smile. Soft natural window light falls across the face, and behind the person is a light warm neutral seamless background (light greige, roughly #d8d2c8). There are no accessories beyond those described. It looks like an 85mm portrait photograph, with natural skin texture and sharp focus on the eyes. The outfit must contrast clearly with the background so the silhouette reads. No text, captions, logos, or watermarks in the image.",
};

test("the Krea 2 face prompt matches its snapshot and stays under the limit", () => {
  const bible = averyBible();
  assert.equal(kreaFacePrompt(bible), EXPECTED.krea);
  assert.equal(kreaFacePrompt(bible, "a heather gray hoodie"), EXPECTED.kreaDarkGarment);
  for (const prompt of Object.values(EXPECTED)) assert.ok(prompt.length < PROMPT_LIMIT);
});

test("it spells out the thirty-degree turn in sentences and keeps the backdrop rule", () => {
  const prompt = kreaFacePrompt(averyBible());
  assert.ok(prompt.startsWith(averyBible().visualCore));
  assert.match(prompt, /The head is turned about thirty degrees to the left, so the far cheek narrows, the near ear shows/);
  assert.doesNotMatch(prompt, /three-quarter view/i);
  assert.equal(backdropOf(prompt), "gray");
  assert.equal(backdropOf(kreaFacePrompt(averyBible(), "a heather gray hoodie")), "light");
});

test("the variant follows the recipe id; everything but Krea 2 keeps the standard prompt", () => {
  const bible = averyBible();
  assert.equal(faceLockPrompt(bible, "krea-2-turbo-t2i"), kreaFacePrompt(bible));
  for (const id of ["z-image-turbo-t2i", "flux-2-dev-t2i", "router-nano-banana-pro-t2i", "mock-text-to-image", undefined]) {
    assert.equal(faceLockPrompt(bible, id), facePrompt(bible), String(id));
  }
});
