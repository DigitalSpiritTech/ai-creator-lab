/**
 * Recipe tags: what a recipe is meant for beyond its capability, shared by recipes and sidecars.
 * @packageDocumentation
 */
import { z } from "zod";

/**
 * `character_start` marks a text-to-image recipe suited to a character's first face lock. A tag on
 * its own never makes a recipe the default; see `DEFAULT_PURPOSE_RECIPE_IDS` in the server catalog.
 */
export const RecipeTagSchema = z.enum(["character_start"]);
export type RecipeTag = z.infer<typeof RecipeTagSchema>;

export const RecipeTagsSchema = z.array(RecipeTagSchema).max(8);
