/**
 * Gallery examples (v0.2 F10): the `examples/` folder at the repository root. Each example is a
 * folder `examples/<id>/` with an `example.json` this schema checks, and the output files it names
 * beside it. An example records what was made and how: the brief, the recipe chosen for each step,
 * the Library items it starts from, the cost settled from the Comfy balance before and after (never
 * the estimate), the outputs, and an honest list of flaws.
 *
 * A `draft` example has no outputs and no cost: it is a brief and a cast waiting for a real run,
 * and the app and the static site show it as "not yet generated". A `published` example has both.
 * The in-app gallery's "Start from this example" turns an example into an inbound context
 * (`exampleInbound`): the brief and the example's Library items, linked to a new project.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema } from "./capability";
import { RecipeIdSchema, Sha256Schema, text } from "./common";
import { AdModeSchema } from "./content";
import { type InboundContextInput, type LibraryRef } from "./inbound";
import { CharacterBibleFieldsSchema, ProductFieldsSchema, SetFieldsSchema } from "./library";
import { AppIdSchema, BriefSchema } from "./project";

/** The example schema version; bump it with a migration note in `examples/README.md`. */
export const GALLERY_SCHEMA_VERSION = 1;

/** An example id: its folder name, lowercase with hyphens. */
export const ExampleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "Use the folder name: lowercase letters, digits, and hyphens.");

/** A file inside the example's own folder: a plain name, no folders, no way out of it. */
export const ExampleFileSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpg|jpeg|webp|mp4)$/, "Name a .png, .jpg, .webp, or .mp4 file in the example's folder.");

export const ExampleStatusSchema = z.enum(["draft", "published"]);
export type ExampleStatus = z.infer<typeof ExampleStatusSchema>;

/** Which recipe ran (or will run) each step, in the order the steps ran. */
export const ExampleRecipeChoiceSchema = z
  .object({
    /** The step, in the content type's words ("face", "frame", "clip", "export"). */
    step: text(40),
    capability: CapabilitySchema,
    recipeId: RecipeIdSchema,
    /** Where it ran: "Comfy Cloud", "Comfy Router", or a backend's label. */
    backend: text(60).optional(),
    note: text(300).optional(),
  })
  .strict();
export type ExampleRecipeChoice = z.infer<typeof ExampleRecipeChoiceSchema>;

/**
 * The Library items an example starts from, as their editable fields (no asset ids: images from a
 * run are outputs, and a new install has none). `key` names the item inside the example.
 */
const LibraryKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const ExampleLibrarySchema = z
  .object({
    characters: z.array(z.object({ key: LibraryKeySchema, bible: CharacterBibleFieldsSchema, wardrobe: text(200).optional() }).strict()).max(3).default([]),
    products: z.array(z.object({ key: LibraryKeySchema, product: ProductFieldsSchema.omit({ imageAssetIds: true }) }).strict()).max(3).default([]),
    sets: z.array(z.object({ key: LibraryKeySchema, set: SetFieldsSchema.omit({ imageAssetIds: true }) }).strict()).max(6).default([]),
  })
  .strict();
export type ExampleLibrary = z.infer<typeof ExampleLibrarySchema>;

/**
 * What the run cost, settled from the Comfy credit balance read before and after it (the same
 * figures as its docs/VERIFICATION.md row), never from estimates or ceilings.
 */
export const ExampleCostSchema = z
  .object({
    balanceBeforeCredits: z.number().nonnegative(),
    balanceAfterCredits: z.number().nonnegative(),
    /** before minus after. */
    credits: z.number().nonnegative(),
    /** credits at the ledger's 210 credits per USD. */
    usd: z.number().nonnegative(),
    /** The date of the run (YYYY-MM-DD) and its VERIFICATION row, for anyone checking. */
    measuredOn: z.iso.date(),
    verificationRow: text(200),
  })
  .strict()
  .refine((cost) => Math.abs(cost.balanceBeforeCredits - cost.balanceAfterCredits - cost.credits) < 0.01, "credits must be the balance before minus the balance after.");
export type ExampleCost = z.infer<typeof ExampleCostSchema>;

export const ExampleOutputSchema = z
  .object({
    kind: z.enum(["export", "still", "clip", "sheet", "face", "body", "product"]),
    file: ExampleFileSchema,
    caption: text(200),
    sha256: Sha256Schema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSeconds: z.number().positive().optional(),
  })
  .strict();
export type ExampleOutput = z.infer<typeof ExampleOutputSchema>;

export const GalleryExampleSchema = z
  .object({
    schemaVersion: z.literal(GALLERY_SCHEMA_VERSION),
    id: ExampleIdSchema,
    status: ExampleStatusSchema,
    title: text(120),
    summary: text(400),
    /** The App and, for the Ad, its mode (`quick` for a Quick Ad). */
    appId: AppIdSchema,
    mode: AdModeSchema.default("full"),
    brief: BriefSchema,
    recipes: z.array(ExampleRecipeChoiceSchema).min(1).max(24),
    library: ExampleLibrarySchema,
    cost: ExampleCostSchema.nullable(),
    outputs: z.array(ExampleOutputSchema).max(24),
    /** What is wrong with the outputs, plainly. A published example lists at least one or says "none seen" in its own words. */
    flaws: z.array(text(300)).max(24),
    /** Who made it and with what, in one line ("The maintainer, Comfy Router, credits only"). */
    madeBy: text(200).optional(),
  })
  .strict()
  .superRefine((example, context) => {
    if (example.status === "draft") {
      if (example.outputs.length) context.addIssue({ code: "custom", path: ["outputs"], message: "A draft has no outputs yet; publish it after the real run." });
      if (example.cost !== null) context.addIssue({ code: "custom", path: ["cost"], message: "A draft has no settled cost yet." });
      return;
    }
    if (example.cost === null) context.addIssue({ code: "custom", path: ["cost"], message: "A published example records its cost from the balance before and after." });
    if (!example.outputs.some((output) => output.kind === "export")) context.addIssue({ code: "custom", path: ["outputs"], message: "A published example includes its export." });
    if (example.flaws.length === 0) context.addIssue({ code: "custom", path: ["flaws"], message: "A published example lists its flaws (or one line saying none were seen)." });
    const files = example.outputs.map((output) => output.file);
    if (new Set(files).size !== files.length) context.addIssue({ code: "custom", path: ["outputs"], message: "Name each output file once." });
  });
export type GalleryExample = z.infer<typeof GalleryExampleSchema>;
export type GalleryExampleInput = z.input<typeof GalleryExampleSchema>;

/** How the app and the site label an example: drafts are "not yet generated". */
export function exampleStatusLabel(example: Pick<GalleryExample, "status">): string {
  return example.status === "draft" ? "Not yet generated" : "Generated";
}

/** An example's Library items in the order an inbound context links them: characters, products, sets. */
export function exampleLibraryItems(example: Pick<GalleryExample, "library">): { kind: LibraryRef["kind"]; key: string; name: string }[] {
  return [
    ...example.library.characters.map((entry) => ({ kind: "character" as const, key: entry.key, name: entry.bible.name })),
    ...example.library.products.map((entry) => ({ kind: "product" as const, key: entry.key, name: entry.product.name })),
    ...example.library.sets.map((entry) => ({ kind: "set" as const, key: entry.key, name: entry.set.name })),
  ];
}

/**
 * The inbound context that starts a project from an example: its brief, the Library items it uses
 * (by the ids they have in this Library, keyed by the example's keys), and the gallery as the source.
 */
export function exampleInbound(example: Pick<GalleryExample, "id" | "brief" | "library">, libraryIds: Readonly<Record<string, string>>): InboundContextInput {
  const libraryRefs = exampleLibraryItems(example).map((item) => {
    const id = libraryIds[`${item.kind}:${item.key}`];
    if (!id) throw new Error(`No Library ${item.kind} for ${item.key} in example ${example.id}.`);
    return { kind: item.kind, id };
  });
  return { brief: example.brief, libraryRefs, source: { kind: "gallery", ref: example.id } };
}
