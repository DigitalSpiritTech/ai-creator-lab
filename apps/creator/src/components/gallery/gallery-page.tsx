/**
 * Gallery page: the examples in `examples/` with their brief, recipe choices, Library items, cost
 * settled from the balance, outputs, and flaws. A draft says "Not yet generated" and shows no
 * outputs or cost. "Start from this example" puts the example's Library items into this Library,
 * then creates a project with `POST /api/projects` and the example's inbound context.
 * @packageDocumentation
 */
"use client";

import { Loader2, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { type GalleryExample, exampleLibraryItems } from "@creator-lab/core/domain/gallery";
import type { InboundContextInput } from "@creator-lab/core/domain/inbound";
import { EmptyState, Notice, PageHeader } from "@/components/shell/page-header";
import { Badge } from "@creator-lab/ui/badge";
import { Button } from "@creator-lab/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@creator-lab/ui/card";
import { errorMessage, getJson, sendJson } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";

type Listed = GalleryExample & { statusLabel: string };

export function GalleryPage() {
  const [examples, setExamples] = useState<Listed[] | null>(null);
  const [problems, setProblems] = useState<{ folder: string; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const listed = await getJson<{ examples: Listed[]; problems: { folder: string; message: string }[] }>("/api/gallery");
      setExamples(listed.examples);
      setProblems(listed.problems);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useLoad(load);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <PageHeader title="Gallery" description="Ads made with the studio, each with its brief, the recipes it used, what it cost, and what is wrong with it. Start a project from any of them." />
      {error ? <div className="mb-4"><Notice>{error}</Notice></div> : null}
      {problems.map((problem) => (
        <div key={problem.folder} className="mb-2"><Notice tone="warn">examples/{problem.folder}: {problem.message}</Notice></div>
      ))}
      {examples === null ? (
        <p className="text-sm text-muted-foreground">Loading the gallery…</p>
      ) : examples.length === 0 ? (
        <EmptyState title="No examples yet">Examples live in the examples folder of the repository.</EmptyState>
      ) : (
        <div className="space-y-4">
          {examples.map((example) => <ExampleCard key={example.id} example={example} />)}
        </div>
      )}
    </div>
  );
}

function ExampleCard({ example }: { example: Listed }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = example.status === "draft";

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const prepared = await sendJson<{ name: string; appId: string; inbound: InboundContextInput; panel: string | null }>(`/api/gallery/${example.id}/start`, {});
      const { project } = await sendJson<{ project: { id: string } }>("/api/projects", { name: prepared.name, appId: prepared.appId, inbound: prepared.inbound });
      router.push(prepared.panel ? `/projects/${project.id}?panel=${encodeURIComponent(prepared.panel)}` : `/projects/${project.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Card data-example={example.id}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{example.title}</CardTitle>
          <div className="flex items-center gap-2">
            {example.mode === "quick" ? <Badge variant="outline">Quick Ad</Badge> : null}
            <Badge variant={draft ? "outline" : "secondary"}>{example.statusLabel}</Badge>
          </div>
        </div>
        <CardDescription>{example.summary}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {draft ? (
          <Notice tone="muted">Not yet generated. This example has its brief, recipes, and Library items, but no outputs or cost until it is run on a real Comfy account.</Notice>
        ) : (
          <div className="flex flex-wrap gap-3">
            {example.outputs.map((output) =>
              output.file.endsWith(".mp4") ? (
                <video key={output.file} src={`/api/gallery/${example.id}/files/${output.file}`} controls preload="metadata" className="aspect-[9/16] w-40 rounded-lg bg-muted" aria-label={output.caption} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- example files come from a local route, not the image optimizer
                <img key={output.file} src={`/api/gallery/${example.id}/files/${output.file}`} alt={output.caption} className="h-40 w-auto rounded-lg bg-muted object-cover" />
              ),
            )}
          </div>
        )}
        <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="font-medium">Brief</dt>
            <dd className="text-muted-foreground">{example.brief.productSummary} · {example.brief.audience} · {example.brief.platforms.join(", ")} · {example.brief.tone}</dd>
          </div>
          <div>
            <dt className="font-medium">Library items</dt>
            <dd className="text-muted-foreground">{exampleLibraryItems(example).map((item) => `${item.name} (${item.kind})`).join(", ") || "none"}</dd>
          </div>
          <div>
            <dt className="font-medium">{draft ? "Recipes planned" : "Recipes"}</dt>
            <dd className="text-muted-foreground">
              <ul>
                {example.recipes.map((choice) => (
                  <li key={`${choice.step}-${choice.recipeId}`}>{choice.step}: <code>{choice.recipeId}</code>{choice.backend ? ` on ${choice.backend}` : ""}</li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt className="font-medium">Cost</dt>
            <dd className="text-muted-foreground">
              {example.cost ? `${example.cost.credits} credits (${example.cost.usd.toFixed(2)} USD), from the balance ${example.cost.balanceBeforeCredits} to ${example.cost.balanceAfterCredits} on ${example.cost.measuredOn}` : "Not yet generated"}
            </dd>
          </div>
          {example.flaws.length ? (
            <div className="sm:col-span-2">
              <dt className="font-medium">Flaws</dt>
              <dd className="text-muted-foreground"><ul className="list-disc pl-4">{example.flaws.map((flaw) => <li key={flaw}>{flaw}</li>)}</ul></dd>
            </div>
          ) : null}
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void start()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Play />} Start from this example
          </Button>
          <span className="text-xs text-muted-foreground">Creates a project with this brief and links the example&apos;s Library items (made in your Library if they are not there yet). Nothing is generated until you approve it.</span>
        </div>
        {error ? <Notice>{error}</Notice> : null}
      </CardContent>
    </Card>
  );
}
