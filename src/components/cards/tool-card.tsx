/**
 * A quiet row for one assistant tool call: a readable line (what it did, what came back), the
 * status, and the raw input and output only on demand.
 * @packageDocumentation
 */
import { CheckCircle2, Loader2, Wrench, XCircle } from "lucide-react";
import { summarizeTool, toolLabel } from "@/lib/client/tool-summary";

export { toolLabel };

export interface ToolActivity {
  id: string;
  name: string;
  input: unknown;
  status: "running" | "ok" | "error";
  output?: unknown;
}

export function ToolCard({ activity }: { activity: ToolActivity }) {
  const Icon = activity.status === "running" ? Loader2 : activity.status === "ok" ? CheckCircle2 : XCircle;
  const summary = summarizeTool(activity.name, activity.input, activity.output, activity.status);
  return (
    <details className="rounded-lg border bg-muted/30 px-2.5 py-1.5 text-xs" data-testid="tool-card">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">
          <span className="font-medium">{summary.title}</span>
          {summary.detail ? <span className="text-muted-foreground"> · {summary.detail}</span> : null}
        </span>
        <Icon
          className={`ml-auto size-3.5 shrink-0 ${activity.status === "running" ? "animate-spin text-muted-foreground" : activity.status === "ok" ? "text-emerald-600" : "text-destructive"}`}
          aria-label={activity.status}
        />
      </summary>
      <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
        <div>
          Tool <code>{activity.name}</code>
          {summary.detail ? <> · {summary.detail}</> : null}
        </div>
        <details>
          <summary className="cursor-pointer">Raw input and output</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ input: activity.input, output: activity.output }, null, 2)}</pre>
        </details>
      </div>
    </details>
  );
}
