/**
 * Shared state for one project page: the loaded project view, refresh, the chat transcript that
 * proposal cards land in (from the assistant, manual mode, or workspace actions), and job polling.
 * @packageDocumentation
 */
"use client";

import { createContext, useContext } from "react";
import type { ToolActivity } from "@/components/cards/tool-card";
import type { GenerationProposal, GenerationTarget, Job, ProjectView } from "@/lib/client/types";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; activity: ToolActivity }
  | { kind: "proposal"; id: string; proposal: GenerationProposal; source: "assistant" | "manual" | "workspace" | "history" }
  | { kind: "notice"; id: string; tone: "error" | "warn" | "ok" | "muted"; text: string };

export interface ProjectContextValue {
  projectId: string;
  view: ProjectView;
  refresh(): Promise<void>;
  /** Shows a proposal card in the chat panel; it goes through the gate from there. */
  propose(proposal: GenerationProposal, source: "assistant" | "manual" | "workspace"): void;
  /** Starts job polling after the gate accepted a proposal. */
  submitted(): void;
  notify(tone: "error" | "warn" | "ok" | "muted", text: string): void;
  /** Jobs still running for this project, and ones that finished in the last few minutes. */
  jobs: { unfinished: Job[]; recent: Job[] };
}

/** One placeholder tile in a candidate grid: a job that is still running, or one that just failed. */
export interface PendingTile {
  id: string;
  label: string;
  status: string;
  failed?: string;
}

/**
 * Placeholder tiles for the jobs aimed at one place in the workspace (a character's face slot, a
 * beat's still), so the grid shows where a result will land while it is being made.
 */
export function pendingTiles(jobs: { unfinished: Job[]; recent: Job[] }, match: (target: GenerationTarget) => boolean, recipeTitle: (id: string) => string): PendingTile[] {
  const running = jobs.unfinished.filter((job) => match(job.request.target)).map((job) => ({ id: job.id, label: recipeTitle(job.recipeId), status: statusText(job) }));
  const failed = jobs.recent
    .filter((job) => job.status === "failed" && match(job.request.target) && !jobs.unfinished.some((other) => other.notice?.includes(job.id)))
    .map((job) => ({ id: job.id, label: recipeTitle(job.recipeId), status: "Failed", failed: job.status === "failed" ? job.error.message : "Failed" }));
  return [...running, ...failed];
}

function statusText(job: Job): string {
  switch (job.status) {
    case "queued":
      return "Waiting for the allowance";
    case "submitting":
      return "Sending";
    case "running":
      return typeof job.progress === "number" && job.progress > 0 && job.progress < 1 ? `Generating, ${Math.round(job.progress * 100)}%` : "Generating";
    case "retrieving":
      return "Downloading";
    case "uncertain":
      return "Checking with the provider";
    default:
      return job.status;
  }
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside a project page.");
  return value;
}

let counter = 0;
/** Client-side ids for transcript items. */
export function localId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
