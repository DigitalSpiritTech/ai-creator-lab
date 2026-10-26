/**
 * Shared state for one project page: the loaded project view, refresh, the chat transcript that
 * proposal cards land in (from the assistant, manual mode, or workspace actions), and job polling.
 * @packageDocumentation
 */
"use client";

import { createContext, useContext } from "react";
import type { ToolActivity } from "@/components/cards/tool-card";
import type { GenerationProposal, ProjectView } from "@/lib/client/types";

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
