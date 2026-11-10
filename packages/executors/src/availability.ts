/**
 * What the proposal card's recipe selector and "Regenerate with..." offer for a capability: recipes
 * that can run on a configured backend now, each with where it runs. Placement is 08's
 * (`placeRecipe` in `@/lib/catalog/availability`, through `recipeAvailability`): the default
 * workflow backend, the Comfy Cloud fallback, Router, or a refusal with the reason. Without routing
 * (contexts with no backend list, most tests and scripts) a recipe runs wherever its executor points.
 *
 * Offered means placeable, and then one of: a mock (listed only with `MOCK_RECIPES=1`), verified on
 * a real account, verified or found compatible by a probe on the backend it would run on, or a
 * Router model the person switched on in Settings.
 * @packageDocumentation
 */
import { type BackendRouting, type Capability, type Placement, type Recipe, placeRecipe, placementNote, recipeStatusOn } from "@creator-lab/core/catalog";
import { recipeAvailability } from "@creator-lab/recipes/defaults";
import type { ExecutorSet } from ".";

export interface AvailabilityContext {
  executors: Pick<ExecutorSet, "forRecipe">;
  /** Router model ids switched on in Settings. */
  routerModels: readonly string[];
  /** The backend list and key status (`GenerationContext.routing`). */
  routing?: BackendRouting;
}

/** Whether a submission of this recipe can reach a backend now. */
export function recipeRunnable(recipe: Recipe, context: Pick<AvailabilityContext, "executors" | "routing">): boolean {
  return context.routing ? placeRecipe(recipe, context.routing).ok : !!context.executors.forRecipe(recipe);
}

function offered(recipe: Recipe, placement: Placement, context: AvailabilityContext): boolean {
  if (!placement.ok) return false;
  if (!context.routing && !context.executors.forRecipe(recipe)) return false;
  if (recipe.kind === "mock" || recipe.verified) return true;
  if (recipe.kind === "router" && context.routerModels.includes(recipe.model)) return true;
  if (placement.backend) {
    const status = recipeStatusOn(recipe, placement.backend).status;
    return status === "verified" || status === "compatible";
  }
  return false;
}

export interface AvailableRecipe {
  recipe: Recipe;
  /** Where it runs when that is worth saying ("Runs on Comfy Cloud because ..."), else empty. */
  note: string;
}

/** Recipes for a capability offered now, verified first and mocks last, with their placement note. */
export function availableRecipes(recipes: Recipe[], capability: Capability, context: AvailabilityContext): AvailableRecipe[] {
  const placed = context.routing
    ? recipeAvailability(recipes, capability, context.routing)
    : recipes.filter((recipe) => recipe.capability === capability).map((recipe) => ({ recipe, placement: { ok: true, backend: null } as Placement }));
  return placed.filter(({ recipe, placement }) => offered(recipe, placement, context)).map(({ recipe, placement }) => ({ recipe, note: placementNote(placement) }));
}
