/**
 * Prompt styles: the family of prompt grammar a recipe's model reads. The creative step writes one
 * model-independent shot spec; each style's renderer turns it into a native prompt
 * (`src/server/tools/render.ts`). A recipe may name its style; otherwise it is inferred from the
 * recipe id or Router model id by {@link inferPromptStyle}.
 * @packageDocumentation
 */
import { z } from "zod";

/**
 * - `standard`: the house prompts verified on Z-Image, Qwen Image Edit, FLUX.2, and the LTX clip
 *   paragraph (references as "reference image N"). Every model without its own style uses it.
 * - `krea`: Krea 2, whose Qwen3-VL encoder reads descriptive sentences (face lock today).
 * - `gemini-image`: the Nano Banana family (Gemini image): one narrative paragraph, references as
 *   "the first image", positive phrasing instead of ban lists.
 * - `gpt-image`: OpenAI GPT Image: labeled sections (intended use, images by index, scene, subject,
 *   constraints), explicit "change only" edits.
 * - `minimax-h3`: MiniMax H3 video with sound, the structured base-mode prompt from the H3 renderer.
 */
export const PromptStyleSchema = z.enum(["standard", "krea", "gemini-image", "gpt-image", "minimax-h3"]);
export type PromptStyle = z.infer<typeof PromptStyleSchema>;

/** Short names for the proposal card ("Prompt written for ..."). */
export const PROMPT_STYLE_LABELS: Record<PromptStyle, string> = {
  standard: "Qwen, Z-Image, FLUX and LTX",
  krea: "Krea 2",
  "gemini-image": "Nano Banana (Gemini image)",
  "gpt-image": "GPT Image",
  "minimax-h3": "MiniMax H3",
};

/** The fields of a recipe that decide its style. */
export interface PromptStyleSource {
  id: string;
  kind: "router" | "workflow" | "mock";
  capability: string;
  promptStyle?: PromptStyle;
  /** Router recipes only: `provider/model`. */
  model?: string;
}

const VIDEO = /_to_video$|^text_to_video$/;

/**
 * The style a recipe's model reads: the recipe's own `promptStyle`, else inferred from its Router
 * model id (Gemini image and Nano Banana, GPT Image, MiniMax H) or its workflow id (Krea 2, MiniMax
 * H3 video), else `standard`. Mocks render `standard` unless they name a style.
 */
export function inferPromptStyle(recipe: PromptStyleSource): PromptStyle {
  if (recipe.promptStyle) return recipe.promptStyle;
  const video = VIDEO.test(recipe.capability);
  if (recipe.kind === "router" && recipe.model) {
    const [provider, name = ""] = recipe.model.toLowerCase().split("/");
    if (!video && provider === "vertexai" && (name.includes("image") || name.includes("banana"))) return "gemini-image";
    if (!video && provider === "openai" && name.startsWith("gpt-image")) return "gpt-image";
    if (video && provider === "minimax" && name.startsWith("minimax-h3")) return "minimax-h3";
    return "standard";
  }
  if (recipe.kind === "workflow") {
    if (!video && recipe.id.startsWith("krea-2-")) return "krea";
    if (video && /^minimax-h3-(i2v|flf2v)$/.test(recipe.id)) return "minimax-h3";
  }
  return "standard";
}
