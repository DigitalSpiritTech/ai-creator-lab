/**
 * A small card for one assistant tool call: name, status, and the input and output on demand.
 * @packageDocumentation
 */
import { CheckCircle2, Loader2, Wrench, XCircle } from "lucide-react";

export interface ToolActivity {
  id: string;
  name: string;
  input: unknown;
  status: "running" | "ok" | "error";
  output?: unknown;
}

export function toolLabel(name: string): string {
  return name.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
}

export function ToolCard({ activity }: { activity: ToolActivity }) {
  const Icon = activity.status === "running" ? Loader2 : activity.status === "ok" ? CheckCircle2 : XCircle;
  return (
    <details className="rounded-lg border bg-muted/30 px-2.5 py-1.5 text-xs" data-testid="tool-card">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <Wrench className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">{toolLabel(activity.name)}</span>
        <Icon
          className={`ml-auto size-3.5 ${activity.status === "running" ? "animate-spin text-muted-foreground" : activity.status === "ok" ? "text-emerald-600" : "text-destructive"}`}
          aria-label={activity.status}
        />
      </summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
        {JSON.stringify({ input: activity.input, output: activity.output }, null, 2)}
      </pre>
    </details>
  );
}
