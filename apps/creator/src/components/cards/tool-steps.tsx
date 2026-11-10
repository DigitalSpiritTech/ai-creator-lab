/**
 * The assistant's work between two things it said: a run of tool calls folded into one quiet
 * line ("3 steps · Read the project · Saved the brief · Proposed a still for beat 6") that
 * shows the current step while one runs and opens into the per-call rows on demand.
 * @packageDocumentation
 */
import { CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import { type ToolActivity, ToolCard } from "@/components/cards/tool-card";
import { summarizeTool } from "@/lib/client/tool-summary";

export function ToolSteps({ activities }: { activities: ToolActivity[] }) {
  const running = activities.find((activity) => activity.status === "running");
  const failed = activities.filter((activity) => activity.status === "error").length;
  const titles = activities.map((activity) => summarizeTool(activity.name, activity.input, activity.output, activity.status).title);
  const count = `${activities.length} step${activities.length === 1 ? "" : "s"}`;
  const head = running ? summarizeTool(running.name, running.input, running.output, "running").title : failed ? `${count}, ${failed} failed` : count;
  const Icon = running ? Loader2 : failed ? XCircle : CheckCircle2;
  return (
    <details className="group rounded-lg border bg-muted/30 text-xs" data-testid="tool-steps">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
        <span className="min-w-0 truncate">
          <span className="font-medium">{head}</span>
          <span className="text-muted-foreground"> · {titles.join(" · ")}</span>
        </span>
        <Icon
          className={`ml-auto size-3.5 shrink-0 ${running ? "animate-spin text-muted-foreground" : failed ? "text-destructive" : "text-emerald-600"}`}
          aria-label={running ? "running" : failed ? "failed" : "done"}
        />
      </summary>
      <ol className="divide-y border-t">
        {activities.map((activity) => (
          <li key={activity.id}>
            <ToolCard activity={activity} plain />
          </li>
        ))}
      </ol>
    </details>
  );
}
