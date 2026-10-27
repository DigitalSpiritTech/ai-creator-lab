/**
 * Starter recipes and per-capability defaults, as decided by the October 26 spike (docs/VERIFICATION.md):
 * Z-Image Turbo for text_to_image, Qwen Image Edit 2511 for image_edit with Nano Banana 2.1 hosted,
 * LTX 2.5 on Cloud for image_to_video, LTX 2.5 first-and-last-frame on Cloud for first_last_to_video. Anything not run on a real account carries `verified: null`.
 * @packageDocumentation
 */
import { resolve } from "node:path";
import { MockRecipeSchema, RouterRecipeSchema, type Capability, type MockRecipe, type Recipe, type RouterRecipe } from "@/lib/catalog";
import { loadWorkflowRecipes, type WorkflowMeta } from "@/server/catalog/workflows";

export const WORKFLOW_META: Record<string, WorkflowMeta> = {
  "z-image-turbo-t2i": {
    title: "Z-Image Turbo on Comfy Cloud",
    verified: "2026-10-26",
    costHint: "About 2 to 3 credits per 1024x1024 still.",
    ceilingUsd: 0.03,
    defaults: { width: 1024, height: 1024 },
  },
  "qwen-image-edit-2511-2ref": {
    title: "Qwen Image Edit 2511, two references, on Comfy Cloud",
    verified: "2026-10-26",
    costHint: "About 7 credits at 768x1344.",
    ceilingUsd: 0.07,
    defaults: { width: 768, height: 1344 },
  },
  "ltx-2.5-i2v": {
    title: "LTX 2.5 image to video on Comfy Cloud",
    verified: "2026-10-26",
    costHint: "About 10 credits for 121 frames at 576x1024 with audio.",
    ceilingUsd: 0.1,
    fitImages: true,
    defaults: { width: 576, height: 1024, length: 121 },
    notes: "Input images are center-cropped and scaled to the output size before upload; the graph needs an exact match.",
  },
  "ltx-2.5-flf2v": {
    title: "LTX 2.5 first and last frame to video on Comfy Cloud",
    verified: null,
    costHint: "Expected near the image-to-video cost, about 10 to 12 credits for 121 frames at 576x1024; not yet measured.",
    ceilingUsd: 0.12,
    fitImages: true,
    defaults: { width: 576, height: 1024, length: 121 },
    notes: "Both frames are center-cropped and scaled to the same output canvas before upload. Not yet run on Comfy Cloud.",
  },
};

const GEMINI_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "9:16", "16:9", "21:9"] as const;

export const ROUTER_RECIPES: RouterRecipe[] = [
  RouterRecipeSchema.parse({
    id: "router-nano-banana-2.1-edit",
    kind: "router",
    title: "Nano Banana 2.1 on Comfy Router",
    capability: "image_edit",
    openWeights: false,
    verified: "2026-10-26",
    costHint: "About 13 credits for a two-reference still at 1K.",
    ceilingUsd: 0.15,
    limits: { aspectRatios: [...GEMINI_RATIOS], sizeTiers: ["1K", "2K", "4K"], maxReferences: 14 },
    defaults: { aspectRatio: "9:16", sizeTier: "1K" },
    provider: "vertexai",
    model: "vertexai/gemini-nano-banana-2.1",
    fieldMap: {
      template: {
        contents: [{ role: "user", parts: [] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageOutputOptions: { mimeType: "image/png" } } },
        uploadImagesToStorage: true,
      },
      prompt: { path: "contents.0.parts.0.text" },
      images: {
        path: "contents.0.parts",
        mode: "append",
        encoding: "base64",
        item: { inlineData: { mimeType: "{mime}", data: "{data}" } },
        min: 1,
        max: 14,
      },
      aspectRatio: { path: "generationConfig.imageConfig.aspectRatio" },
      sizeTier: { path: "generationConfig.imageConfig.imageSize" },
      seed: { path: "generationConfig.seed" },
      output: "gemini",
    },
  }),
  RouterRecipeSchema.parse({
    id: "router-ltx-2.5-fast",
    kind: "router",
    title: "LTX 2.5 Fast on Comfy Router",
    capability: "text_to_video",
    openWeights: false,
    verified: null,
    costHint: "Priced by Router per second; not yet measured here.",
    ceilingUsd: 1,
    limits: { aspectRatios: ["9:16", "16:9"], durations: [2, 3, 4, 5, 6, 8, 10] },
    defaults: { aspectRatio: "9:16", durationSeconds: 5 },
    notes: "Router's schema for this model takes a prompt only, so it cannot animate a start frame.",
    provider: "ltx",
    model: "ltx/ltx-2-5-fast",
    fieldMap: {
      template: { generate_audio: true, fps: 24 },
      prompt: { path: "prompt" },
      aspectRatio: { path: "resolution", values: { "9:16": "1080x1920", "16:9": "1920x1080" } },
      duration: { path: "duration" },
      output: "ltx",
    },
  }),
  RouterRecipeSchema.parse({
    id: "router-wan-3-i2v",
    kind: "router",
    title: "Wan 3 image to video on Comfy Router",
    capability: "image_to_video",
    openWeights: false,
    verified: null,
    costHint: "Priced by Router; not yet measured here.",
    ceilingUsd: 1,
    limits: { aspectRatios: ["9:16", "16:9", "1:1"], durations: [5], maxReferences: 1 },
    defaults: { aspectRatio: "9:16", durationSeconds: 5 },
    provider: "wan",
    model: "wan/wan3.0-video",
    fieldMap: {
      template: { input: {}, parameters: { resolution: "720P", prompt_extend: false, audio: true, watermark: false } },
      prompt: { path: "input.prompt" },
      images: {
        path: "input.media",
        mode: "append",
        encoding: "data_url",
        item: { type: "{role}", url: "{data}" },
        roles: ["first_frame"],
        min: 1,
        max: 1,
      },
      aspectRatio: { path: "parameters.ratio" },
      duration: { path: "parameters.duration" },
      seed: { path: "parameters.seed" },
      output: "wan",
    },
  }),
  RouterRecipeSchema.parse({
    id: "router-wan-3-flf2v",
    kind: "router",
    title: "Wan 3 first and last frame on Comfy Router",
    capability: "first_last_to_video",
    openWeights: false,
    verified: null,
    costHint: "Priced by Router; not yet measured here.",
    ceilingUsd: 1,
    limits: { aspectRatios: ["9:16", "16:9", "1:1"], durations: [5], maxReferences: 2 },
    defaults: { aspectRatio: "9:16", durationSeconds: 5 },
    provider: "wan",
    model: "wan/wan3.0-video",
    fieldMap: {
      template: { input: {}, parameters: { resolution: "720P", prompt_extend: false, audio: true, watermark: false } },
      prompt: { path: "input.prompt" },
      images: {
        path: "input.media",
        mode: "append",
        encoding: "data_url",
        item: { type: "{role}", url: "{data}" },
        roles: ["first_frame", "last_frame"],
        min: 2,
        max: 2,
      },
      aspectRatio: { path: "parameters.ratio" },
      duration: { path: "parameters.duration" },
      seed: { path: "parameters.seed" },
      output: "wan",
    },
  }),
];

const MOCK_CAPABILITIES: Capability[] = ["text_to_image", "image_edit", "image_to_video", "first_last_to_video", "text_to_video"];

export const MOCK_RECIPES: MockRecipe[] = MOCK_CAPABILITIES.map((capability) =>
  MockRecipeSchema.parse({
    id: `mock-${capability.replaceAll("_", "-")}`,
    kind: "mock",
    title: `Mock ${capability.replaceAll("_", " ")} (no AI, free)`,
    capability,
    openWeights: false,
    verified: null,
    costHint: "Free. A labeled placeholder, not a generation.",
    ceilingUsd: 0,
    limits: { maxReferences: 16 },
    defaults: { aspectRatio: "9:16" },
  }),
);

/** The default recipe per MVP capability and the hosted alternative, by recipe id. */
export const DEFAULT_RECIPE_IDS: Partial<Record<Capability, { primary: string; hosted?: string; mock: string }>> = {
  text_to_image: { primary: "z-image-turbo-t2i", mock: "mock-text-to-image" },
  image_edit: { primary: "qwen-image-edit-2511-2ref", hosted: "router-nano-banana-2.1-edit", mock: "mock-image-edit" },
  image_to_video: { primary: "ltx-2.5-i2v", hosted: "router-wan-3-i2v", mock: "mock-image-to-video" },
  first_last_to_video: { primary: "ltx-2.5-flf2v", hosted: "router-wan-3-flf2v", mock: "mock-first-last-to-video" },
  text_to_video: { primary: "router-ltx-2.5-fast", mock: "mock-text-to-video" },
};

/**
 * Whether the mock recipes are listed. They exist for tests and the acceptance smoke, not for
 * creators, so a real install hides them unless `MOCK_RECIPES=1` is set.
 */
export function mockRecipesEnabled(): boolean {
  return process.env.MOCK_RECIPES === "1";
}

/**
 * Every starter recipe: the workflow sidecars on disk and the curated Router recipes, plus the
 * mocks when `options.mocks` (default: {@link mockRecipesEnabled}) allows them.
 */
export async function defaultRecipes(workflowsDir: string = resolve(process.cwd(), "workflows"), options: { mocks?: boolean } = {}): Promise<Recipe[]> {
  const { recipes } = await loadWorkflowRecipes(workflowsDir, WORKFLOW_META);
  const mocks = options.mocks ?? mockRecipesEnabled();
  return [...recipes, ...ROUTER_RECIPES, ...(mocks ? MOCK_RECIPES : [])];
}

/** Recipes for a capability: verified first, then unverified, mocks last. */
export function recipesFor(recipes: Recipe[], capability: Capability): Recipe[] {
  const rank = (recipe: Recipe) => (recipe.kind === "mock" ? 2 : recipe.verified ? 0 : 1);
  return recipes.filter((recipe) => recipe.capability === capability).sort((a, b) => rank(a) - rank(b));
}
