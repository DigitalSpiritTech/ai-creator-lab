/**
 * Workspace settings stored in SQLite. API keys are never stored here; they come from the environment.
 * The spend fields are the monthly budget and its reset day; see `@/lib/domain/spend` for the policy.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema } from "./capability";
import { RecipeIdSchema, RevisionSchema, TimestampSchema } from "./common";
import { fail } from "./failure";
import { BudgetAmountSchema, BudgetResetDaySchema } from "./spend";

/**
 * Settings saved before the monthly budget (v0.2 F2) carry `allowanceUsd`; it becomes the monthly
 * budget, with the reset day defaulting to the 1st. Migration 4 rewrites the stored row the same way.
 */
function upgradeLegacySettings(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("allowanceUsd" in value)) return value;
  const { allowanceUsd, ...rest } = value as Record<string, unknown>;
  return "monthlyBudgetUsd" in rest ? rest : { ...rest, monthlyBudgetUsd: allowanceUsd };
}

export const WorkspaceSettingsSchema = z.preprocess(
  upgradeLegacySettings,
  z
    .object({
      defaultRecipes: z.partialRecord(CapabilitySchema, RecipeIdSchema).default({}),
      /** Comfy Router model ids the user switched on; each gets a recipe per capability its adapter supports. */
      routerModels: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200)).max(200).default([]),
      /** What paid generation may spend each budget period, in USD, before any extension. */
      monthlyBudgetUsd: BudgetAmountSchema.default(0),
      /** Day of the month (1 to 28, UTC) a new budget period starts. */
      budgetResetDay: BudgetResetDaySchema.default(1),
      autoApprove: z.boolean().default(false),
      revision: RevisionSchema.default(0),
      updatedAt: TimestampSchema.default(0),
    })
    .strict(),
);
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

export const UpdateWorkspaceSettingsSchema = z
  .object({
    defaultRecipes: z.partialRecord(CapabilitySchema, RecipeIdSchema).optional(),
    routerModels: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200)).max(200).optional(),
    monthlyBudgetUsd: BudgetAmountSchema.optional(),
    budgetResetDay: BudgetResetDaySchema.optional(),
    autoApprove: z.boolean().optional(),
    revision: RevisionSchema.optional(),
  })
  .strict();
export type UpdateWorkspaceSettings = z.infer<typeof UpdateWorkspaceSettingsSchema>;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = WorkspaceSettingsSchema.parse({});

/** Applies a settings edit; a stale `revision` in the patch is a conflict. */
export function updateWorkspaceSettings(
  current: WorkspaceSettings,
  patch: UpdateWorkspaceSettings,
  now: number,
): WorkspaceSettings {
  if (patch.revision !== undefined && patch.revision !== current.revision) {
    fail("conflict", "Settings changed in another view. Reload them before saving.");
  }
  return WorkspaceSettingsSchema.parse({
    defaultRecipes: patch.defaultRecipes ?? current.defaultRecipes,
    routerModels: patch.routerModels ?? current.routerModels,
    monthlyBudgetUsd: patch.monthlyBudgetUsd ?? current.monthlyBudgetUsd,
    budgetResetDay: patch.budgetResetDay ?? current.budgetResetDay,
    autoApprove: patch.autoApprove ?? current.autoApprove,
    revision: current.revision + 1,
    updatedAt: now,
  });
}

/**
 * The base cap before any extension: the lower of the monthly budget and the operator's
 * `GENERATION_ALLOWANCE_USD`. Zero disables paid runs. The policy in force, with this period's
 * extension and spend, is `composeSpendPolicy` in `@/lib/domain/spend`.
 */
export function effectiveAllowanceUsd(settings: WorkspaceSettings, environmentAllowanceUsd: number): number {
  const operator = Number.isFinite(environmentAllowanceUsd) && environmentAllowanceUsd > 0 ? environmentAllowanceUsd : 0;
  return Math.min(settings.monthlyBudgetUsd, operator);
}
