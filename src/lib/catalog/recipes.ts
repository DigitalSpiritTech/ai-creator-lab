/**
 * Recipes: concrete ways to fulfill a capability, either a hosted Router model with a semantic
 * field map, an API-format workflow with a slot sidecar, or the credit-free mock.
 * @packageDocumentation
 */
import { z } from "zod";
import { AspectRatioSchema, CapabilitySchema } from "@/lib/catalog/capabilities";
import { SlotSidecarSchema } from "@/lib/catalog/slots";

export const RecipeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,79}$/);
export const RouterModelIdSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200);

/** Dotted path into a JSON body; numeric segments index arrays, e.g. `contents.0.parts`. */
export const BodyPathSchema = z.string().regex(/^[A-Za-z_][\w-]*(\.(\d+|[A-Za-z_][\w-]*))*$/).max(200);

export const RecipeLimitsSchema = z
  .object({
    aspectRatios: z.array(AspectRatioSchema).optional(),
    sizes: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).optional(),
    sizeTiers: z.array(z.string()).optional(),
    maxReferences: z.number().int().nonnegative().optional(),
    durations: z.array(z.number().positive()).optional(),
    fps: z.number().positive().optional(),
  })
  .default({});

export const RecipeDefaultsSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    length: z.number().int().positive(),
    durationSeconds: z.number().positive(),
    aspectRatio: AspectRatioSchema,
    sizeTier: z.string(),
  })
  .partial()
  .default({});

const commonFields = {
  id: RecipeIdSchema,
  title: z.string().min(1).max(120),
  capability: CapabilitySchema,
  openWeights: z.boolean(),
  /** ISO date of the last real run that passed, or null when untested. */
  verified: z.iso.date().nullable(),
  costHint: z.string().max(200),
  /** Most this recipe is expected to cost in USD; reserved against the allowance when no live quote exists. */
  ceilingUsd: z.number().nonnegative().optional(),
  limits: RecipeLimitsSchema,
  defaults: RecipeDefaultsSchema,
  notes: z.string().max(600).optional(),
};

const FieldTargetSchema = z
  .object({
    path: BodyPathSchema,
    /** Optional lookup from the semantic value (for example "9:16") to the native value ("1080x1920"). */
    values: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  })
  .strict();
export const FieldTargetsSchema = z.union([FieldTargetSchema, z.array(FieldTargetSchema).min(1).max(4)]);
export type FieldTargets = z.infer<typeof FieldTargetsSchema>;

export const ImageFieldSchema = z
  .object({
    path: BodyPathSchema,
    /** `append` pushes one item per image into the array at path; `set` writes the first image at path; `indexed` writes each image to its own path from `paths`. */
    mode: z.enum(["append", "set", "indexed"]),
    /** With mode `indexed`: the body path for each image position, for example input_image, input_image_2. */
    paths: z.array(BodyPathSchema).max(16).optional(),
    /** How the bytes travel: raw base64, a `data:` URL, or a short-lived uploaded asset URL. */
    encoding: z.enum(["base64", "data_url", "url"]),
    /** JSON template per image; the strings "{data}", "{mime}", and "{role}" are replaced. */
    item: z.unknown(),
    /** Role per position for `{role}`, the last one repeating, e.g. ["first_frame", "last_frame"]. */
    roles: z.array(z.string()).optional(),
    min: z.number().int().nonnegative().default(0),
    max: z.number().int().positive(),
  })
  .strict();
export type ImageField = z.infer<typeof ImageFieldSchema>;

export const RouterOutputFamilySchema = z.enum(["gemini", "flux", "minimax", "wan", "kling", "seedance", "ltx", "openai", "binary"]);
export type RouterOutputFamily = z.infer<typeof RouterOutputFamilySchema>;

export const RouterFieldMapSchema = z
  .object({
    template: z.record(z.string(), z.unknown()).default({}),
    prompt: FieldTargetsSchema,
    images: ImageFieldSchema.optional(),
    aspectRatio: FieldTargetsSchema.optional(),
    sizeTier: FieldTargetsSchema.optional(),
    duration: FieldTargetsSchema.optional(),
    seed: FieldTargetsSchema.optional(),
    output: RouterOutputFamilySchema.optional(),
  })
  .strict();
export type RouterFieldMap = z.infer<typeof RouterFieldMapSchema>;

export const RouterRecipeSchema = z.object({
  ...commonFields,
  kind: z.literal("router"),
  provider: z.string().min(1).max(80),
  model: RouterModelIdSchema,
  fieldMap: RouterFieldMapSchema,
});

export const WorkflowRecipeSchema = z.object({
  ...commonFields,
  kind: z.literal("workflow"),
  /** File name under `workflows/`. */
  file: z.string().regex(/^[\w.-]+\.api\.json$/),
  target: z.enum(["cloud", "any"]),
  sidecar: SlotSidecarSchema,
  /** Center-crop and Lanczos-scale image inputs to the output size before upload (the LTX graph needs this). */
  fitImages: z.boolean().default(false),
});

export const MockRecipeSchema = z.object({ ...commonFields, kind: z.literal("mock") });

export const RecipeSchema = z.discriminatedUnion("kind", [RouterRecipeSchema, WorkflowRecipeSchema, MockRecipeSchema]);
export type Recipe = z.infer<typeof RecipeSchema>;
export type RouterRecipe = z.infer<typeof RouterRecipeSchema>;
export type WorkflowRecipe = z.infer<typeof WorkflowRecipeSchema>;
export type MockRecipe = z.infer<typeof MockRecipeSchema>;
export type RecipeKind = Recipe["kind"];
