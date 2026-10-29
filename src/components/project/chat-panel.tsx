/**
 * The project chat: streamed assistant text, tool activity as small cards, and proposal cards that
 * go through the spending gate. Proposals from manual mode and workspace actions land here too.
 * @packageDocumentation
 */
"use client";

import { Loader2, SendHorizonal, Square } from "lucide-react";
import { useReadOnly } from "@/components/demo-mode";
import { useEffect, useRef, useState } from "react";
import { ProposalCard } from "@/components/cards/proposal-card";
import type { ToolActivity } from "@/components/cards/tool-card";
import { ToolSteps } from "@/components/cards/tool-steps";
import { type ChatItem, localId, useProject } from "@/components/project/project-context";
import { Notice } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/client/api";
import { applyAgentEvent, parseAgentEvent } from "@/lib/client/chat";
import { readSse } from "@/lib/client/sse";

type RenderItem = Exclude<ChatItem, { kind: "tool" }> | { kind: "steps"; id: string; activities: ToolActivity[] };

/** Folds each run of consecutive tool calls into one steps block, so a turn's work reads as a line, not a stack of cards. */
export function groupSteps(items: ChatItem[]): RenderItem[] {
  const grouped: RenderItem[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      grouped.push(item);
      continue;
    }
    const last = grouped.at(-1);
    if (last && last.kind === "steps") last.activities = [...last.activities, item.activity];
    else grouped.push({ kind: "steps", id: `steps-${item.id}`, activities: [item.activity] });
  }
  return grouped;
}

export function ChatPanel({ items, setItems }: { items: ChatItem[]; setItems: React.Dispatch<React.SetStateAction<ChatItem[]>> }) {
  const readOnly = useReadOnly();
  const { projectId, view, refresh, submitted } = useProject();
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items]);

  useEffect(() => () => abort.current?.abort(), []);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const message = draft.trim();
    if (!message || streaming) return;
    setDraft("");
    setStreaming(true);
    const controller = new AbortController();
    abort.current = controller;
    let turnStart = 0;
    setItems((current) => {
      const next = [...current, { kind: "user" as const, id: localId("user"), text: message }];
      turnStart = next.length;
      return next;
    });
    try {
      const response = await fetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "The assistant could not start.");
      }
      for await (const frame of readSse(response.body)) {
        const agentEvent = parseAgentEvent(frame.data);
        if (!agentEvent) continue;
        setItems((current) => applyAgentEvent(current, agentEvent, turnStart, localId));
        if (agentEvent.type === "tool_result" && agentEvent.ok) void refresh();
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setItems((current) => [...current, { kind: "notice", id: localId("error"), tone: "error", text: errorMessage(cause) }]);
      }
    } finally {
      setStreaming(false);
      abort.current = null;
      void refresh();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            Tell the assistant what you are selling, who buys it, where the ad runs, and the tone. For example: “A 32 oz insulated bottle for
            commuters, for TikTok, warm and direct like Avery Lane.”
          </div>
        ) : null}
        {groupSteps(items).map((item) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={item.id} className="ml-auto max-w-[85%] rounded-xl bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                  {item.text}
                </div>
              );
            case "assistant":
              return (
                <div key={item.id} className="max-w-[90%] rounded-xl bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
                  {item.text}
                </div>
              );
            case "steps":
              return <ToolSteps key={item.id} activities={item.activities} />;
            case "proposal":
              return (
                <ProposalCard
                  key={item.id}
                  proposal={item.proposal}
                  autoApprove={view.autoApprove && item.source !== "history"}
                  onSubmitted={() => {
                    submitted();
                    void refresh();
                  }}
                />
              );
            case "notice":
              return <Notice key={item.id} tone={item.tone}>{item.text}</Notice>;
          }
        })}
        {streaming ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> The assistant is working…
          </div>
        ) : null}
        <div ref={bottom} />
      </div>
      <form onSubmit={send} className="border-t p-3">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={readOnly ? "The assistant is off in this read-only demo." : "Message the assistant"}
          rows={3}
          aria-label="Message the assistant"
          className="resize-none"
          disabled={readOnly}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{readOnly ? "Read-only demo." : view.autoApprove ? "Auto-approve is on: proposals run under your allowance." : "Every generation waits for your approval."}</span>
          {streaming ? (
            <Button type="button" size="sm" variant="outline" onClick={() => abort.current?.abort()}>
              <Square /> Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={readOnly || !draft.trim()}>
              <SendHorizonal /> Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
