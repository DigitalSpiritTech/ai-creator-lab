/**
 * Per-model prompt rendering: one shot spec in, the prompt in the recipe's own grammar out. Each
 * prompt style (see `PromptStyleSchema`) has a renderer per spec kind; a style without a renderer
 * for a kind uses the house (`standard`) one, which is what every model got before shot specs.
 *
 * | Style | Native renderers | Module |
 * | --- | --- | --- |
 * | standard | every kind | `prompts.ts` (Z-Image, Qwen Image Edit, FLUX.2, LTX and the other video models) |
 * | krea | face | `prompts.ts` (`kreaFacePrompt`) |
 * | gemini-image | face, body, sheet, product photo, still, refine | `prompts-gemini-image.ts` |
 * | gpt-image | face, body, sheet, product photo, still, refine | `prompts-gpt-image.ts` |
 * | minimax-h3 | clip (start and first-last) | `prompts-minimax-h3.ts` via {@link h3ClipSpec} |
 *
 * Renderers are pure, never throw on content, and stay within the recipe's limit
 * ({@link promptLimit}); a spec that cannot be rendered for a model returns a readable error.
 * @packageDocumentation
 */
import { type PromptStyle, type PromptStyleSource, inferPromptStyle } from "@/lib/catalog";
import type { ClipSpec, ShotSpec } from "@/lib/domain/shot-spec";
import { geminiBodyPrompt, geminiFacePrompt, geminiProductPhotoPrompt, geminiRefinePrompt, geminiSheetPrompt, geminiStillPrompt } from "@/server/tools/prompts-gemini-image";
import { gptBodyPrompt, gptFacePrompt, gptProductPhotoPrompt, gptRefinePrompt, gptSheetPrompt, gptStillPrompt } from "@/server/tools/prompts-gpt-image";
import { H3_PROMPT_LIMIT, type H3ShotSpecInput, renderH3SingleShot } from "@/server/tools/prompts-minimax-h3";
import {
  PROMPT_LIMIT,
  bodyPrompt,
  clipPrompt,
  facePrompt,
  kreaFacePrompt,
  productPhotoPrompt,
  referenceSheetPrompt,
  refinePrompt,
  stillPrompt,
  withoutProductName,
} from "@/server/tools/prompts";

export type RenderResult = { ok: true; prompt: string; style: PromptStyle } | { ok: false; style: PromptStyle; error: string };

type Renderers = { [K in ShotSpec["kind"]]?: (spec: Extract<ShotSpec, { kind: K }>) => string | { error: string } };

const STANDARD: Required<Renderers> = {
  face: (spec) => facePrompt(spec, spec.garment),
  body: (spec) => bodyPrompt(spec, spec.backdrop, { photographed: spec.photographed }),
  sheet: (spec) => referenceSheetPrompt(spec, spec.wardrobe, { photographed: spec.photographed }),
  product_photo: (spec) => productPhotoPrompt(spec.product, spec.setting),
  still: (spec) =>
    stillPrompt({
      beat: spec.beat,
      bible: spec.visualCore ? { visualCore: spec.visualCore } : undefined,
      wardrobe: spec.wardrobe,
      character: spec.character,
      product: spec.product,
      set: spec.set,
    }),
  refine: (spec) => refinePrompt(spec.instruction, spec.subject),
  clip: (spec) => clipPrompt(spec.beat, { product: spec.product, speech: spec.mode === "speech" }),
  speech: (spec) => spec.line,
  free: (spec) => spec.prompt,
};

const RENDERERS: Record<PromptStyle, Renderers> = {
  standard: STANDARD,
  krea: { face: (spec) => kreaFacePrompt(spec, spec.garment) },
  "gemini-image": {
    face: geminiFacePrompt,
    body: geminiBodyPrompt,
    sheet: geminiSheetPrompt,
    product_photo: geminiProductPhotoPrompt,
    still: geminiStillPrompt,
    refine: geminiRefinePrompt,
  },
  "gpt-image": {
    face: gptFacePrompt,
    body: gptBodyPrompt,
    sheet: gptSheetPrompt,
    product_photo: gptProductPhotoPrompt,
    still: gptStillPrompt,
    refine: gptRefinePrompt,
  },
  "minimax-h3": { clip: renderH3Clip },
};

/** The longest prompt a style's renderer may return (free prompts keep their own 8000 bound). */
export function promptLimit(style: PromptStyle): number {
  return style === "minimax-h3" ? H3_PROMPT_LIMIT : PROMPT_LIMIT;
}

/** Whether a style writes its own prompt for this kind of spec rather than the house prompt. */
export function rendersNatively(style: PromptStyle, kind: ShotSpec["kind"]): boolean {
  return style === "standard" || RENDERERS[style][kind] !== undefined;
}

/** Renders a spec for a recipe in the recipe's prompt style. */
export function renderPrompt(spec: ShotSpec, recipe: PromptStyleSource): RenderResult {
  const style = inferPromptStyle(recipe);
  const renderer = (RENDERERS[style][spec.kind] ?? STANDARD[spec.kind]) as (value: ShotSpec) => string | { error: string };
  const used: PromptStyle = RENDERERS[style][spec.kind] ? style : "standard";
  const output = renderer(spec);
  if (typeof output !== "string") return { ok: false, style: used, error: output.error };
  const limit = spec.kind === "free" ? 8000 : promptLimit(used);
  if (output.length > limit) return { ok: false, style: used, error: `The ${used} prompt is ${output.length} characters; the limit is ${limit}. Shorten the beat's visual or the setting.` };
  return { ok: true, prompt: output, style: used };
}

/** Text H3 reads as free text: no double quotes (they render as on-screen text) and no tags. */
function plain(value: string): string {
  return value.replace(/["“”]/g, "").replace(/<[^<>]*>/g, "").replace(/\s{2,}/g, " ").trim();
}

function speakerId(name: string): string {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "") ?? "";
  return /^[a-z]/.test(first) ? first.slice(0, 40) : "creator";
}

/**
 * The H3 shot spec for one beat's clip: the approved still is <Picture 1> (the first frame), the
 * ending still <Picture 2> for first and last frame. The base modes anchor to <Picture 1>, so the
 * character's look and the product's appearance are carried by the image; the bible and card text
 * are passed only because the schema defines subjects with them. Talking beats carry the line as
 * dialogue; b-roll and text cards are ambient (their voice-over is mixed in at export).
 */
export function h3ClipSpec(spec: ClipSpec): H3ShotSpecInput {
  const { beat, character, product } = spec;
  const talking = beat.type === "talking" && !!character;
  const id = character ? speakerId(character.name) : "creator";
  const name = character ? character.name.trim().split(/\s+/)[0] : "";
  const visual = plain(product ? withoutProductName(beat.visual, product) : beat.visual);
  const setting = plain(beat.setting) || "the setting shown in <Picture 1>";
  const subjects = talking ? [id] : [];
  return {
    durationSeconds: spec.durationSeconds,
    subjects: talking ? [{ id, name, description: plain(character.visualCore), wardrobe: plain(character.wardrobe), ...(character.voice ? { voice: plain(character.voice).slice(0, 200) } : {}) }] : [],
    pictures: [
      { index: 1, role: "first_frame", shot: 1, ...(talking ? { subject: id } : {}), shows: visual },
      ...(spec.mode === "first_last" ? [{ index: 2, role: "last_frame" as const, shot: 1, ...(talking ? { subject: id } : {}), shows: "the same shot a few seconds later" }] : []),
    ],
    shots: [
      {
        startSeconds: 0,
        endSeconds: spec.durationSeconds,
        framing: beat.type === "talking" ? "medium close-up" : beat.type === "broll" ? "close-up" : "medium shot",
        setting,
        lighting: "the light shown in <Picture 1>",
        subjects,
        action:
          beat.type === "talking"
            ? `${talking ? name : "The person"} looks into the phone camera and talks with an easy smile and small natural head movement`
            : beat.type === "broll"
              ? "The action shown in <Picture 1> continues in one simple, smooth motion"
              : "The scene stays almost still with very subtle natural motion",
        camera: beat.type === "talking" ? { move: "shake_slightly", amplitude: "small" } : beat.type === "broll" ? { move: "push_in", amplitude: "small", speed: "slow" } : { move: "static" },
        ...(product && beat.productVisible ? { product: "facing the camera" } : {}),
      },
    ],
    dialogue: talking && beat.spokenLine ? [{ speaker: id, shot: 1, text: plain(beat.spokenLine).replace(/\.\.\.|…/g, ","), ...(character.voice ? {} : { tone: "in a relaxed, natural voice" }) }] : [],
    ...(product ? { product: { name: product.name, ...(product.appearance ? { appearance: product.appearance } : {}) } } : {}),
    soundscape: `Quiet ambient sound of ${setting.replace(/^the setting shown in <Picture 1>$/, "the room")}.`,
    music: "N/A",
  };
}

/** The H3 base-mode prompt for a clip spec; speech-driven clips are not an H3 mode. */
export function renderH3Clip(spec: ClipSpec): string | { error: string } {
  if (spec.mode === "speech") return { error: "MiniMax H3 does not lip-sync to a recording; use a speech to video recipe." };
  const rendered = renderH3SingleShot(h3ClipSpec(spec));
  if (!rendered.ok) return { error: `MiniMax H3 cannot render beat ${spec.beat.index}: ${rendered.errors[0]}` };
  return rendered.prompt;
}
