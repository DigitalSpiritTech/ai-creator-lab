/**
 * The project page: chat (or manual mode) on the left, the workspace with Script, Shots, Assets,
 * and Export tabs on the right, and a job strip while generations run.
 * @packageDocumentation
 */
"use client";

import { Loader2, MessageSquare, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { AssetsTab } from "@/components/project/assets-tab";
import { ChatPanel } from "@/components/project/chat-panel";
import { ExportTab } from "@/components/project/export-tab";
import { ManualPanel } from "@/components/project/manual-panel";
import { type ChatItem, ProjectContext, type ProjectContextValue, localId } from "@/components/project/project-context";
import { ScriptTab } from "@/components/project/script-tab";
import { ShotsTab } from "@/components/project/shots-tab";
import { Notice } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { useLoad } from "@/lib/client/use-load";
import { errorMessage, getJson } from "@/lib/client/api";
import { describeJobStatus, describeTarget } from "@/lib/client/format";
import type { ProjectView as ProjectViewData } from "@/lib/client/types";
import { type StoredMessage, historyToItems } from "@/lib/client/chat";
import { useJobPolling } from "@/lib/client/use-job-polling";
import { cn } from "@/lib/utils";

const TABS = ["Script", "Shots", "Assets", "Export"] as const;
type Tab = (typeof TABS)[number];

export function ProjectView({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProjectViewData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [tab, setTab] = useState<Tab>("Script");
  const [mode, setMode] = useState<"chat" | "manual">("chat");

  const refresh = useCallback(async () => {
    try {
      setView(await getJson<ProjectViewData>(`/api/projects/${projectId}`));
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    }
  }, [projectId]);

  useLoad(refresh);

  const loadHistory = useCallback(async () => {
    try {
      const { messages } = await getJson<{ messages: StoredMessage[] }>(`/api/projects/${projectId}/chat`);
      setItems((current) => (current.length ? current : historyToItems(messages)));
    } catch {
      // The transcript starts empty; the stored conversation still reaches the assistant.
    }
  }, [projectId]);
  useLoad(loadHistory);

  const jobs = useJobPolling(projectId, refresh);

  const context = useMemo<ProjectContextValue | null>(
    () =>
      view && {
        projectId,
        view,
        refresh,
        propose: (proposal, source) => {
          setItems((current) =>
            current.some((item) => item.kind === "proposal" && item.proposal.id === proposal.id)
              ? current
              : [...current, { kind: "proposal", id: `proposal-${proposal.id}`, proposal, source }],
          );
          setMode("chat");
        },
        submitted: jobs.kick,
        notify: (tone, text) => setItems((current) => [...current, { kind: "notice", id: localId("notice"), tone, text }]),
      },
    [projectId, view, refresh, jobs.kick],
  );

  if (!context) {
    return (
      <div className="p-8">
        {loadError ? (
          <Notice>
            {loadError} <Link className="underline" href="/projects">Back to projects</Link>
          </Notice>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading project…</p>
        )}
      </div>
    );
  }

  const failed = jobs.recent.filter((job) => job.status === "failed");

  return (
    <ProjectContext.Provider value={context}>
      <div className="flex h-screen min-h-0 flex-col">
        <header className="flex items-center justify-between gap-4 border-b px-5 py-3">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground"><Link href="/projects" className="hover:underline">Projects</Link> / UGC Creator</div>
            <h1 className="truncate text-lg font-semibold tracking-tight">{context.view.project.name}</h1>
          </div>
          {context.view.project.brief ? (
            <p className="line-clamp-2 max-w-xl text-xs text-muted-foreground">
              {context.view.project.brief.productSummary} · {context.view.project.brief.audience} · {context.view.project.brief.platforms.join(", ")} · {context.view.project.brief.tone}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No brief yet. Start in the chat.</p>
          )}
        </header>
        {jobs.unfinished.length || failed.length ? (
          <div className="flex flex-wrap items-center gap-3 border-b bg-muted/40 px-5 py-1.5 text-xs" role="status">
            {jobs.unfinished.length ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {jobs.unfinished.length} generation{jobs.unfinished.length === 1 ? "" : "s"} running
              </span>
            ) : null}
            {jobs.unfinished.slice(0, 4).map((job) => (
              <span key={job.id} className="text-muted-foreground">
                {describeTarget(job.request.target)}: {describeJobStatus(job.status)}
                {job.notice ? ` (${job.notice})` : ""}
              </span>
            ))}
            {failed.slice(0, 2).map((job) => (
              <span key={job.id} className="text-destructive">
                {describeTarget(job.request.target)} failed{job.status === "failed" ? `: ${job.error.message}` : ""}
              </span>
            ))}
          </div>
        ) : null}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,420px)_1fr]">
          <section className="flex min-h-0 flex-col border-r" aria-label={mode === "chat" ? "Chat" : "Manual mode"}>
            <div className="flex gap-1 border-b p-2" role="tablist">
              <Button size="sm" variant={mode === "chat" ? "secondary" : "ghost"} role="tab" aria-selected={mode === "chat"} onClick={() => setMode("chat")}>
                <MessageSquare /> Chat
              </Button>
              <Button size="sm" variant={mode === "manual" ? "secondary" : "ghost"} role="tab" aria-selected={mode === "manual"} onClick={() => setMode("manual")}>
                <SlidersHorizontal /> Manual
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              {mode === "chat" ? <ChatPanel items={items} setItems={setItems} /> : <ManualPanel />}
            </div>
          </section>
          <section className="flex min-h-0 flex-col" aria-label="Workspace">
            <div className="flex gap-1 border-b p-2" role="tablist">
              {TABS.map((name) => (
                <Button key={name} size="sm" variant={tab === name ? "secondary" : "ghost"} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
                  {name}
                </Button>
              ))}
            </div>
            <div className={cn("min-h-0 flex-1 overflow-y-auto p-5")}>
              {tab === "Script" ? <ScriptTab /> : null}
              {tab === "Shots" ? <ShotsTab /> : null}
              {tab === "Assets" ? <AssetsTab /> : null}
              {tab === "Export" ? <ExportTab /> : null}
            </div>
          </section>
        </div>
      </div>
    </ProjectContext.Provider>
  );
}
