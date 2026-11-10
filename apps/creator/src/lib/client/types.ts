/**
 * Response shapes of the API routes, derived from the server's Zod contracts (type-only imports,
 * so nothing from the server reaches the client bundle).
 * @packageDocumentation
 */
import type { z } from "zod";
import type { Asset } from "@creator-lab/core/domain/asset";
import type { ExportRecord } from "@creator-lab/core/domain/content";
import type { GenerationProposal, GenerationTarget, Job } from "@creator-lab/core/domain/job";
import type { CharacterItem, LibraryItem, ProjectLink } from "@creator-lab/core/domain/library";
import type { Project } from "@creator-lab/core/domain/project";
import type { BudgetCrossing, SpendPolicy, SpendWarning } from "@creator-lab/core/domain/spend";
import type { WorkspaceSettings } from "@creator-lab/core/domain/workspace";
import type { AssetUsage } from "@creator-lab/core/domain/usage";
import type { RecipeOptionSchema } from "@/server/tools/overrides";
import type { ProjectStateSchema } from "@/server/tools/project";

export type ProjectState = z.infer<typeof ProjectStateSchema>;

export interface ProjectView extends ProjectState {
  targets: Record<string, GenerationTarget>;
  recipes: Record<string, string>;
  exports: ExportRecord[];
  autoApprove: boolean;
}

export type ProjectSummary = Project & { assetCount: number };

export interface RecipeSummary {
  id: string;
  title: string;
  capability: string;
  kind: "router" | "workflow" | "mock";
  verified: boolean;
  verifiedOn: string | null;
  openWeights: boolean;
  costHint: string;
  available: boolean;
}

/** One entry in the proposal card's recipe selector. */
export type RecipeOption = z.infer<typeof RecipeOptionSchema>;

/** What the recipe selector lists, with this project's preference and the Settings default. */
export interface RecipeOptionsView {
  capability: string;
  references: number;
  options: RecipeOption[];
  preference: string | null;
  settingsDefault: string | null;
}

export interface SubmitResult {
  requestId: string;
  outcome: "started" | "existing" | "completed" | "failed" | "blocked" | "needs_confirmation";
  job: Job | null;
  assetIds: string[];
  message: string | null;
  reserveUsd: number | null;
  /** Set on a blocked result when the run would cross this month's remaining budget. */
  budget: BudgetCrossing | null;
}

/** What the spending gate returns for one proposal. */
export interface SubmitResponse {
  results: SubmitResult[];
  /** The share of this month's budget in use: 0, 50, 80, or 100 percent. */
  warning: SpendWarning;
}

export interface SettingsView {
  workspace: WorkspaceSettings;
  keys: {
    comfyApiKey: { present: boolean; source: "environment" | "settings" | null };
    anthropicApiKey: { present: boolean; source: "environment" | "settings" | null };
    llmModel: { value: string | null; source: "environment" | "settings" | null };
    /** Which provider runs the assistant; defaults to "anthropic". */
    llmProvider: { value: string; source: "environment" | "settings" | null };
  };
  /** This period's budget, extension, spend, and the read-only operator ceiling. */
  spend: SpendPolicy;
  creditsPerUsd: number;
  dataDirectory: string;
}

export interface ConnectionView {
  configured: boolean;
  ok: boolean;
  status: string | null;
  credits: number | null;
  cloudCredits: number | null;
  prepaidCredits: number | null;
  message: string;
  checkedAt: number;
}

export interface JobsView {
  unfinished: Job[];
  /** Jobs that finished in the last few minutes, so the UI can surface failures. */
  recent: Job[];
}

export interface LibraryView {
  items: LibraryItem[];
  links: ProjectLink[];
  projects: Pick<Project, "id" | "name">[];
}

export interface LibraryItemView {
  item: LibraryItem;
  links: ProjectLink[];
  projects: (Pick<Project, "id" | "name"> & { linked: boolean })[];
  assets: Asset[];
}

export interface UsageView {
  asset: Asset;
  usage: AssetUsage[];
  /** Human-readable lines naming each affected item. */
  affected: string[];
}

export type { Asset, CharacterItem, ExportRecord, GenerationProposal, GenerationTarget, Job, LibraryItem, ProjectLink };
