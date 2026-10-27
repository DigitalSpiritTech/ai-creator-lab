/**
 * Recipes for Comfy Router models the user switches on in Settings. Each provider family whose
 * request and response shapes the app knows gets an adapter that turns a model id into one recipe per
 * capability. Models with no adapter are listed in Settings as not yet supported.
 * @packageDocumentation
 */
import { type Capability, type RouterRecipe, RouterRecipeSchema } from "@/lib/catalog";

export interface AdapterInfo {
  /** Short name of the family, shown in Settings. */
  family: string;
  capabilities: Capability[];
}

const PORTRAIT_RATIOS = ["9:16", "16:9", "1:1", "4:5", "3:4"] as const;
const GEMINI_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "9:16", "16:9", "21:9"] as const;

function slug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-|-$/g, "");
}

function title(model: string, suffix: string): string {
  const [provider, name] = model.split("/");
  return `${name} (${provider}) ${suffix} on Comfy Router`;
}

function recipe(model: string, capability: Capability, suffix: string, fields: Record<string, unknown>): RouterRecipe {
  const [provider] = model.split("/");
  return RouterRecipeSchema.parse({
    id: `router-${slug(model)}-${capability.replaceAll("_", "-")}`,
    kind: "router",
    title: title(model, suffix),
    capability,
    openWeights: false,
    verified: null,
    costHint: "Priced by Router at run time; not yet measured here.",
    provider,
    model,
    ...fields,
  });
}

function geminiImage(model: string): RouterRecipe[] {
  const fieldMap = (references?: { min: number; max: number }) => ({
    template: {
      contents: [{ role: "user", parts: [] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageOutputOptions: { mimeType: "image/png" } } },
      uploadImagesToStorage: true,
    },
    prompt: { path: "contents.0.parts.0.text" },
    ...(references ? { images: { path: "contents.0.parts", mode: "append", encoding: "base64", item: { inlineData: { mimeType: "{mime}", data: "{data}" } }, min: references.min, max: references.max } } : {}),
    aspectRatio: { path: "generationConfig.imageConfig.aspectRatio" },
    sizeTier: { path: "generationConfig.imageConfig.imageSize" },
    seed: { path: "generationConfig.seed" },
    output: "gemini",
  });
  const limits = { aspectRatios: [...GEMINI_RATIOS], sizeTiers: ["1K", "2K", "4K"] };
  return [
    recipe(model, "text_to_image", "from text", { ceilingUsd: 0.25, limits: { ...limits, maxReferences: 0 }, defaults: { aspectRatio: "4:5", sizeTier: "1K" }, fieldMap: fieldMap() }),
    recipe(model, "image_edit", "edit", { ceilingUsd: 0.25, limits: { ...limits, maxReferences: 14 }, defaults: { aspectRatio: "9:16", sizeTier: "1K" }, fieldMap: fieldMap({ min: 1, max: 14 }) }),
  ];
}

const BFL_SIZES: Record<string, [number, number]> = { "9:16": [768, 1376], "16:9": [1376, 768], "1:1": [1024, 1024], "4:5": [896, 1120], "3:4": [864, 1152] };

function bflImage(model: string): RouterRecipe[] {
  const fieldMap = (references: number) => ({
    template: { output_format: "png", prompt_upsampling: false },
    prompt: { path: "prompt" },
    ...(references
      ? { images: { path: "input_image", mode: "indexed", paths: ["input_image", ...Array.from({ length: references - 1 }, (_, i) => `input_image_${i + 2}`)], encoding: "base64", item: "{data}", min: 1, max: references } }
      : {}),
    aspectRatio: [
      { path: "width", values: Object.fromEntries(Object.entries(BFL_SIZES).map(([k, v]) => [k, v[0]])) },
      { path: "height", values: Object.fromEntries(Object.entries(BFL_SIZES).map(([k, v]) => [k, v[1]])) },
    ],
    seed: { path: "seed" },
    output: "flux",
  });
  const limits = { aspectRatios: [...PORTRAIT_RATIOS] };
  return [
    recipe(model, "text_to_image", "from text", { ceilingUsd: 0.2, limits: { ...limits, maxReferences: 0 }, defaults: { aspectRatio: "4:5" }, fieldMap: fieldMap(0) }),
    recipe(model, "image_edit", "edit", { ceilingUsd: 0.2, limits: { ...limits, maxReferences: 9 }, defaults: { aspectRatio: "9:16" }, fieldMap: fieldMap(9) }),
  ];
}

function klingImage(model: string): RouterRecipe[] {
  const fieldMap = (references: number) => ({
    template: { resolution: "1k", n: 1, result_type: "single" },
    prompt: { path: "prompt" },
    ...(references ? { images: { path: "image_list", mode: "append", encoding: "base64", item: { image: "{data}" }, min: 1, max: references } } : {}),
    aspectRatio: { path: "aspect_ratio" },
    output: "kling",
  });
  const limits = { aspectRatios: ["9:16", "16:9", "1:1", "4:3", "3:4", "3:2", "2:3"] };
  return [
    recipe(model, "text_to_image", "from text", { ceilingUsd: 0.2, limits: { ...limits, maxReferences: 0 }, defaults: { aspectRatio: "3:4" }, fieldMap: fieldMap(0) }),
    recipe(model, "image_edit", "edit", { ceilingUsd: 0.2, limits: { ...limits, maxReferences: 10 }, defaults: { aspectRatio: "9:16" }, fieldMap: fieldMap(10) }),
  ];
}

const WHOLE_3_TO_15 = Array.from({ length: 13 }, (_, i) => i + 3);
const KLING_DURATIONS = Object.fromEntries(WHOLE_3_TO_15.map((n) => [String(n), String(n)]));

function klingOmniVideo(model: string): RouterRecipe[] {
  const fieldMap = (references: { min: number; max: number }) => ({
    template: { mode: "pro", sound: "on" },
    prompt: { path: "prompt" },
    images: { path: "image_list", mode: "append", encoding: "base64", item: { image_url: "{data}", type: "{role}" }, roles: ["first_frame", "end_frame"], min: references.min, max: references.max },
    aspectRatio: { path: "aspect_ratio" },
    duration: { path: "duration", values: KLING_DURATIONS },
    output: "kling",
  });
  const limits = { aspectRatios: ["9:16", "16:9", "1:1"], durations: WHOLE_3_TO_15 };
  return [
    recipe(model, "image_to_video", "image to video", { ceilingUsd: 0.8, limits: { ...limits, maxReferences: 1 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 1, max: 1 }) }),
    recipe(model, "first_last_to_video", "first and last frame", { ceilingUsd: 0.8, limits: { ...limits, maxReferences: 2 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 2, max: 2 }) }),
    recipe(model, "text_to_video", "from text", { ceilingUsd: 0.8, limits: { ...limits, maxReferences: 0 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: { template: { mode: "pro", sound: "on" }, prompt: { path: "prompt" }, aspectRatio: { path: "aspect_ratio" }, duration: { path: "duration", values: KLING_DURATIONS }, output: "kling" } }),
  ];
}

function klingTextVideo(model: string): RouterRecipe[] {
  return [
    recipe(model, "text_to_video", "from text", {
      ceilingUsd: 0.8,
      limits: { aspectRatios: ["9:16", "16:9", "1:1"], durations: WHOLE_3_TO_15, maxReferences: 0 },
      defaults: { aspectRatio: "9:16", durationSeconds: 5 },
      fieldMap: { template: { mode: "pro", sound: "on" }, prompt: { path: "prompt" }, aspectRatio: { path: "aspect_ratio" }, duration: { path: "duration", values: KLING_DURATIONS }, output: "kling" },
    }),
  ];
}

const SEEDANCE_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12];

function seedanceVideo(model: string): RouterRecipe[] {
  const fieldMap = (references: { min: number; max: number }) => ({
    template: { content: [{ type: "text", text: "" }], resolution: "720p", generate_audio: true, watermark: false },
    prompt: { path: "content.0.text" },
    ...(references.max
      ? { images: { path: "content", mode: "append", encoding: "data_url", item: { type: "image_url", image_url: { url: "{data}" }, role: "{role}" }, roles: ["first_frame", "last_frame"], min: references.min, max: references.max } }
      : {}),
    aspectRatio: { path: "ratio" },
    duration: { path: "duration" },
    seed: { path: "seed" },
    output: "seedance",
  });
  const limits = { aspectRatios: ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"], durations: SEEDANCE_DURATIONS };
  return [
    recipe(model, "text_to_video", "from text", { ceilingUsd: 1, limits: { ...limits, maxReferences: 0 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 0, max: 0 }) }),
    recipe(model, "image_to_video", "image to video", { ceilingUsd: 1, limits: { ...limits, maxReferences: 1 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 1, max: 1 }) }),
    recipe(model, "first_last_to_video", "first and last frame", { ceilingUsd: 1, limits: { ...limits, maxReferences: 2 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 2, max: 2 }) }),
  ];
}

const MINIMAX_DURATIONS = Array.from({ length: 12 }, (_, i) => i + 4);

function minimaxVideo(model: string): RouterRecipe[] {
  const fieldMap = (references: { min: number; max: number }) => ({
    template: { content: [{ type: "text", text: "" }], resolution: "768P", aigc_watermark: false },
    prompt: { path: "content.0.text" },
    ...(references.max
      ? { images: { path: "content", mode: "append", encoding: "data_url", item: { type: "image_url", image_url: { url: "{data}" }, role: "{role}" }, roles: ["first_frame", "last_frame"], min: references.min, max: references.max } }
      : {}),
    aspectRatio: { path: "ratio" },
    duration: { path: "duration" },
    seed: { path: "seed" },
    output: "minimax",
  });
  const limits = { aspectRatios: ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"], durations: MINIMAX_DURATIONS };
  return [
    recipe(model, "text_to_video", "from text", { ceilingUsd: 1, limits: { ...limits, maxReferences: 0 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 0, max: 0 }) }),
    recipe(model, "image_to_video", "image to video", { ceilingUsd: 1, limits: { ...limits, maxReferences: 1 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 1, max: 1 }) }),
    recipe(model, "first_last_to_video", "first and last frame", { ceilingUsd: 1, limits: { ...limits, maxReferences: 2 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 2, max: 2 }) }),
  ];
}

function wanVideo(model: string): RouterRecipe[] {
  const fieldMap = (references: { min: number; max: number }, roles: string[]) => ({
    template: { input: {}, parameters: { resolution: "720P", prompt_extend: false, audio: true, watermark: false } },
    prompt: { path: "input.prompt" },
    ...(references.max ? { images: { path: "input.media", mode: "append", encoding: "data_url", item: { type: "{role}", url: "{data}" }, roles, min: references.min, max: references.max } } : {}),
    aspectRatio: { path: "parameters.ratio" },
    duration: { path: "parameters.duration" },
    seed: { path: "parameters.seed" },
    output: "wan",
  });
  const limits = { aspectRatios: ["9:16", "16:9", "1:1"], durations: [5] };
  return [
    recipe(model, "text_to_video", "from text", { ceilingUsd: 1, limits: { ...limits, maxReferences: 0 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 0, max: 0 }, []) }),
    recipe(model, "image_to_video", "image to video", { ceilingUsd: 1, limits: { ...limits, maxReferences: 1 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 1, max: 1 }, ["first_frame"]) }),
    recipe(model, "first_last_to_video", "first and last frame", { ceilingUsd: 1, limits: { ...limits, maxReferences: 2 }, defaults: { aspectRatio: "9:16", durationSeconds: 5 }, fieldMap: fieldMap({ min: 2, max: 2 }, ["first_frame", "last_frame"]) }),
  ];
}

function ltxVideo(model: string): RouterRecipe[] {
  return [
    recipe(model, "text_to_video", "from text", {
      ceilingUsd: 1,
      limits: { aspectRatios: ["9:16", "16:9"], durations: [2, 3, 4, 5, 6, 8, 10], maxReferences: 0 },
      defaults: { aspectRatio: "9:16", durationSeconds: 5 },
      notes: "Router's schema for this model takes a prompt only.",
      fieldMap: { template: { generate_audio: true, fps: 24 }, prompt: { path: "prompt" }, aspectRatio: { path: "resolution", values: { "9:16": "1080x1920", "16:9": "1920x1080" } }, duration: { path: "duration" }, output: "ltx" },
    }),
  ];
}

function openaiImage(model: string): RouterRecipe[] {
  return [
    recipe(model, "text_to_image", "from text", {
      ceilingUsd: 0.3,
      limits: { aspectRatios: ["1:1", "9:16", "16:9", "4:5", "3:4"], maxReferences: 0 },
      defaults: { aspectRatio: "4:5" },
      notes: "Generation only; the edit operation needs image uploads this adapter does not send yet.",
      fieldMap: { template: { n: 1, quality: "medium", output_format: "png" }, prompt: { path: "prompt" }, aspectRatio: { path: "size", values: { "1:1": "1024x1024", "9:16": "1024x1536", "4:5": "1024x1536", "3:4": "1024x1536", "16:9": "1536x1024" } }, output: "openai" },
    }),
  ];
}

type Adapter = { info: AdapterInfo; build: (model: string) => RouterRecipe[] };

/** The adapter for a Router model id, matched by provider and model name. */
export function adapterFor(model: string): Adapter | null {
  const [provider, name = ""] = model.split("/");
  const n = name.toLowerCase();
  if (provider === "vertexai" && (n.includes("image") || n.includes("banana"))) return { info: { family: "Gemini image", capabilities: ["text_to_image", "image_edit"] }, build: geminiImage };
  if (provider === "bfl" && !n.includes("video") && !n.includes("erase") && !n.includes("expand") && !n.includes("fill")) return { info: { family: "FLUX (BFL)", capabilities: ["text_to_image", "image_edit"] }, build: bflImage };
  if (provider === "kling" && n === "kling-image-o1") return { info: { family: "Kling image", capabilities: ["text_to_image", "image_edit"] }, build: klingImage };
  if (provider === "kling" && (n.endsWith("-omni") || n === "kling-video-o1")) return { info: { family: "Kling omni video", capabilities: ["image_to_video", "first_last_to_video", "text_to_video"] }, build: klingOmniVideo };
  if (provider === "kling" && /^kling-v\d/.test(n)) return { info: { family: "Kling text video", capabilities: ["text_to_video"] }, build: klingTextVideo };
  if (provider === "byteplus" && n.includes("seedance")) return { info: { family: "Seedance", capabilities: ["text_to_video", "image_to_video", "first_last_to_video"] }, build: seedanceVideo };
  if (provider === "minimax" && n.startsWith("minimax-h")) return { info: { family: "MiniMax video", capabilities: ["text_to_video", "image_to_video", "first_last_to_video"] }, build: minimaxVideo };
  if (provider === "wan" && n.includes("video")) return { info: { family: "Wan video", capabilities: ["text_to_video", "image_to_video", "first_last_to_video"] }, build: wanVideo };
  if (provider === "ltx") return { info: { family: "LTX video", capabilities: ["text_to_video"] }, build: ltxVideo };
  if (provider === "openai" && n.startsWith("gpt-image")) return { info: { family: "OpenAI image", capabilities: ["text_to_image"] }, build: openaiImage };
  return null;
}

/** Recipes for every enabled model that has an adapter; unknown ids are skipped. */
export function adapterRecipes(models: readonly string[]): RouterRecipe[] {
  const out: RouterRecipe[] = [];
  for (const model of models) {
    const adapter = adapterFor(model);
    if (adapter) out.push(...adapter.build(model));
  }
  return out;
}
