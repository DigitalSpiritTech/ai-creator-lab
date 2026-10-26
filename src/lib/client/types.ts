/**
 * Response shapes of the API routes, derived from the server's Zod contracts (type-only imports,
 * so nothing from the server reaches the client bundle).
 * @packageDocumentation
 */
import type { z } from "zod";
import type { Asset } from "@/lib/domain/asset";
import type { ExportRecord } from "@/lib/domain/content";
import type { GenerationProposal, GenerationTarget, Job } from "@/lib/domain/job";
import type { CharacterItem, LibraryItem, ProjectLink } from "@/lib/domain/library";
import type { Project } from "@/lib/domain/project";
import type { WorkspaceSettings } from "@/lib/domain/workspace";
import type { AssetUsage } from "@/lib/domain/usage";
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

export interface SubmitResult {
  requestId: string;
  outcome: "started" | "existing" | "completed" | "failed" | "blocked" | "needs_confirmation";
  job: Job | null;
  assetIds: string[];
  message: string | null;
  reserveUsd: number | null;
}

export interface SettingsView {
  workspace: WorkspaceSettings;
  keys: {
    comfyApiKey: { present: boolean; source: "environment" | "settings" | null };
    anthropicApiKey: { present: boolean; source: "environment" | "settings" | null };
    llmModel: { value: string | null; source: "environment" | "settings" | null };
  };
  allowance: { operatorUsd: number; effectiveUsd: number; spentUsd: number; reservedUsd: number };
  dataDirectory: string;
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
