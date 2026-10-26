/**
 * Workspace settings stored in SQLite. API keys are never stored here; they come from the environment.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema } from "@/lib/domain/capability";
import { RecipeIdSchema, RevisionSchema, TimestampSchema } from "@/lib/domain/common";
import { fail } from "@/lib/domain/failure";

export const WorkspaceSettingsSchema = z
  .object({
    defaultRecipes: z.partialRecord(CapabilitySchema, RecipeIdSchema).default({}),
    allowanceUsd: z.number().nonnegative().max(10_000).default(0),
    autoApprove: z.boolean().default(false),
    revision: RevisionSchema.default(0),
    updatedAt: TimestampSchema.default(0),
  })
  .strict();
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

export const UpdateWorkspaceSettingsSchema = z
  .object({
    defaultRecipes: z.partialRecord(CapabilitySchema, RecipeIdSchema).optional(),
    allowanceUsd: z.number().nonnegative().max(10_000).optional(),
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
    allowanceUsd: patch.allowanceUsd ?? current.allowanceUsd,
    autoApprove: patch.autoApprove ?? current.autoApprove,
    revision: current.revision + 1,
    updatedAt: now,
  });
}

/**
 * The paid-generation cap actually in force: the lower of the workspace setting and the
 * operator's `GENERATION_ALLOWANCE_USD`. Zero disables paid runs.
 */
export function effectiveAllowanceUsd(settings: WorkspaceSettings, environmentAllowanceUsd: number): number {
  const operator = Number.isFinite(environmentAllowanceUsd) && environmentAllowanceUsd > 0 ? environmentAllowanceUsd : 0;
  return Math.min(settings.allowanceUsd, operator);
}
