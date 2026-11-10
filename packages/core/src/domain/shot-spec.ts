/**
 * The shot spec: what the creative step decided a generation should show, independent of the model
 * that will make it. Every generation tool writes one; the recipe's prompt renderer turns it into a
 * native prompt (`src/server/tools/render.ts`). Changing the recipe on a proposal card, or
 * "Regenerate with..." on a rejected candidate, re-renders the same spec for another model, so no
 * step is re-briefed.
 *
 * Content rules carried by the spec itself: identity comes only from the saved bible (`visualCore`,
 * `build`, wardrobe, voice), the product only from its card (name, which renderers remove, and the
 * appearance line), and image references by their position in the proposal's reference list.
 * @packageDocumentation
 */
import { z } from "zod";
import { text } from "./common";
import { BeatSchema } from "./script";

/** A reference image by its 1-based position in the proposal's references. */
const ImageNumberSchema = z.number().int().min(1).max(16);

/** A product as prompts see it: the card's name (never printed) and its appearance line. */
export const SpecProductSchema = z
  .object({
    name: text(120),
    appearance: z.string().trim().max(300).optional(),
  })
  .strict();
export type SpecProduct = z.infer<typeof SpecProductSchema>;

export const BackdropSchema = z.enum(["gray", "light"]);

/** A face lock from text: the bible's visual core and the top shown at the shoulders. */
const FaceSpecSchema = z.object({ kind: z.literal("face"), visualCore: text(600), garment: text(200) }).strict();

/** A full-body reference made from the locked face (reference image `face`). */
const BodySpecSchema = z
  .object({
    kind: z.literal("body"),
    build: text(300),
    backdrop: BackdropSchema,
    face: ImageNumberSchema.default(1),
    photographed: z.boolean().default(false),
  })
  .strict();

/** The project's reference sheet from the locked face and body in the project's wardrobe. */
const SheetSpecSchema = z
  .object({
    kind: z.literal("sheet"),
    visualCore: text(600),
    wardrobe: text(300),
    face: ImageNumberSchema.default(1),
    body: ImageNumberSchema.default(2),
    photographed: z.boolean().default(false),
  })
  .strict();

/** A product photo from the card's appearance line, standing in a setting. */
const ProductPhotoSpecSchema = z
  .object({ kind: z.literal("product_photo"), product: SpecProductSchema, setting: text(200).optional() })
  .strict();

const StillCharacterSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("sheet"), image: ImageNumberSchema, photographed: z.boolean().default(false) }).strict(),
  z.object({ mode: z.literal("face"), face: ImageNumberSchema, body: ImageNumberSchema.optional(), photographed: z.boolean().default(false) }).strict(),
]);

/** One beat's start frame: the beat, and the character, product, and set references it uses. */
const StillSpecSchema = z
  .object({
    kind: z.literal("still"),
    beat: BeatSchema,
    /** The bible's visual core, present when the character is in the frame. */
    visualCore: text(600).optional(),
    wardrobe: z.string().trim().max(300).nullable().default(null),
    character: StillCharacterSchema.optional(),
    product: SpecProductSchema.extend({ image: ImageNumberSchema.optional() }).strict().optional(),
    set: z.object({ name: text(120), image: ImageNumberSchema.optional(), photo: z.boolean().default(false) }).strict().optional(),
  })
  .strict();

/** A text-guided edit of one image (reference image 1) that keeps everything else. */
const RefineSpecSchema = z
  .object({ kind: z.literal("refine"), instruction: text(1000), subject: z.enum(["still", "sheet"]).default("still") })
  .strict();

/** The character as a video model may need it; base modes anchor to the first frame instead of restating it. */
const ClipCharacterSchema = z
  .object({
    name: text(80),
    visualCore: text(600),
    wardrobe: text(300),
    /** How the voice sounds, from the bible. */
    voice: z.string().trim().max(200).optional(),
  })
  .strict();

/** One beat's clip from its approved still (reference 1), with an ending frame or a voice take. */
const ClipSpecSchema = z
  .object({
    kind: z.literal("clip"),
    beat: BeatSchema,
    mode: z.enum(["start", "first_last", "speech"]).default("start"),
    durationSeconds: z.number().positive().max(15),
    character: ClipCharacterSchema.optional(),
    product: SpecProductSchema.optional(),
  })
  .strict();

/** A line read in the creator's voice: every speech model reads the words as they are. */
const SpeechSpecSchema = z.object({ kind: z.literal("speech"), line: text(300) }).strict();

/** A prompt the assistant or the user wrote; every renderer passes it through unchanged. */
const FreeSpecSchema = z.object({ kind: z.literal("free"), prompt: text(8000) }).strict();

export const ShotSpecSchema = z.discriminatedUnion("kind", [
  FaceSpecSchema,
  BodySpecSchema,
  SheetSpecSchema,
  ProductPhotoSpecSchema,
  StillSpecSchema,
  RefineSpecSchema,
  ClipSpecSchema,
  SpeechSpecSchema,
  FreeSpecSchema,
]);
export type ShotSpec = z.infer<typeof ShotSpecSchema>;
export type ShotSpecInput = z.input<typeof ShotSpecSchema>;
export type ShotSpecKind = ShotSpec["kind"];
export type FaceSpec = z.infer<typeof FaceSpecSchema>;
export type BodySpec = z.infer<typeof BodySpecSchema>;
export type SheetSpec = z.infer<typeof SheetSpecSchema>;
export type ProductPhotoSpec = z.infer<typeof ProductPhotoSpecSchema>;
export type StillSpec = z.infer<typeof StillSpecSchema>;
export type RefineSpec = z.infer<typeof RefineSpecSchema>;
export type ClipSpec = z.infer<typeof ClipSpecSchema>;
export type SpeechSpec = z.infer<typeof SpeechSpecSchema>;

/**
 * The longest prompt a person may type into a proposal card. The card's prompt is user input:
 * validated with this on the way back to the server, never trusted for length.
 */
export const EDITED_PROMPT_LIMIT = 8000;
export const EditedPromptSchema = z.string().trim().min(1, "The prompt is empty.").max(EDITED_PROMPT_LIMIT, `Keep the prompt under ${EDITED_PROMPT_LIMIT} characters.`);
