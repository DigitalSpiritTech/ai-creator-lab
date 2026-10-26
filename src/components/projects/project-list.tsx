/**
 * Projects page: every project, newest first, and a form to start one from UGC Creator.
 * @packageDocumentation
 */
"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { EmptyState, Notice, PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLoad } from "@/lib/client/use-load";
import { errorMessage, getJson, sendJson } from "@/lib/client/api";
import { formatDate } from "@/lib/client/format";
import type { ProjectSummary } from "@/lib/client/types";

export function ProjectList() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProjects((await getJson<{ projects: ProjectSummary[] }>("/api/projects")).projects);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useLoad(load);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await sendJson<{ project: { id: string } }>("/api/projects", { name: name.trim() });
      router.push(`/projects/${project.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <PageHeader title="Projects" description="Each project holds its own script, shots, and assets, and links to characters and products in the Library." />
      <form onSubmit={create} className="mb-6 flex max-w-xl gap-2" aria-label="New project">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ridgeline bottle, October" maxLength={80} aria-label="Project name" />
        <Button type="submit" disabled={busy || !name.trim()}>
          <Plus /> New UGC Creator project
        </Button>
      </form>
      {error ? <div className="mb-4"><Notice>{error}</Notice></div> : null}
      {projects === null ? (
        <p className="text-sm text-muted-foreground">Loading projects…</p>
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet">Name your first project above. The assistant opens once it exists.</EmptyState>
      ) : (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`} className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <Card className="h-full transition-colors hover:bg-muted/40">
                <CardHeader>
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription>UGC Creator · updated {formatDate(project.updatedAt)}</CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  {project.brief ? project.brief.productSummary : "No brief yet."}
                  <div className="mt-2 text-xs">{project.assetCount} active asset{project.assetCount === 1 ? "" : "s"}</div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
