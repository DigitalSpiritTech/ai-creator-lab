/**
 * Per-project recipe preferences ("Use for the rest of this project", or "use Nano Banana for
 * product shots from now on" in the chat): one recipe id per capability, stored beside the project
 * so a preference never bumps the project's revision (the brief editor keys on it).
 *
 * Which recipe a step runs, first match wins:
 * 1. the explicit per-run choice (a `recipeId` on the tool, the proposal card's selector);
 * 2. this project's preference for the capability;
 * 3. the workspace default for the capability (Settings);
 * 4. the purpose default (`character_start` for a face lock, when configured and verified);
 * 5. the capability's starter default, its siblings, open weights, the hosted alternative, the mock.
 * Steps 2 to 5 are skipped when the recipe cannot run here or cannot take the step's reference
 * count; an explicit choice that cannot is refused instead. See `proposalRecipe` in the server tools.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema, type Capability } from "./capability";
import { IdSchema, RecipeIdSchema, RevisionSchema, TimestampSchema } from "./common";

export const ProjectPreferencesSchema = z
  .object({
    projectId: IdSchema,
    /** The preferred recipe per capability for this project. */
    recipes: z.partialRecord(CapabilitySchema, RecipeIdSchema).default({}),
    revision: RevisionSchema.default(0),
    updatedAt: TimestampSchema.default(0),
  })
  .strict();
export type ProjectPreferences = z.infer<typeof ProjectPreferencesSchema>;

/** A project with nothing set yet. */
export function emptyPreferences(projectId: string): ProjectPreferences {
  return ProjectPreferencesSchema.parse({ projectId });
}

/** Sets (or with `recipeId` null, clears) the preferred recipe for one capability. */
export function setRecipePreference(current: ProjectPreferences, capability: Capability, recipeId: string | null, now: number): ProjectPreferences {
  const recipes = { ...current.recipes };
  if (recipeId === null) delete recipes[capability];
  else recipes[capability] = recipeId;
  return ProjectPreferencesSchema.parse({ ...current, recipes, revision: current.revision + 1, updatedAt: now });
}
