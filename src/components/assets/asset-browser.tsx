/**
 * Assets and Archive pages: every asset with filters by project, type, and recipe. Active assets
 * can be archived; archived ones restored. Delete everywhere asks first and lists every item that
 * would lose the file.
 * @packageDocumentation
 */
"use client";

import { Archive, ArchiveRestore, Download, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AssetMedia } from "@/components/media/asset-media";
import { EmptyState, Notice, PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useLoad } from "@/lib/client/use-load";
import { assetUrl, callTool, errorMessage, getJson } from "@/lib/client/api";
import { formatDate } from "@/lib/client/format";
import type { Asset, ProjectSummary, UsageView } from "@/lib/client/types";

export function assetQuery(filters: { state: "active" | "archived"; projectId: string; kind: string; recipeId: string }): string {
  const params = new URLSearchParams({ state: filters.state });
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.recipeId) params.set("recipeId", filters.recipeId);
  return `/api/assets?${params.toString()}`;
}

export function AssetBrowser({ mode }: { mode: "active" | "archived" }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [kind, setKind] = useState("");
  const [recipeId, setRecipeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<UsageView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await getJson<{ assets: Asset[] }>(assetQuery({ state: mode, projectId, kind, recipeId: recipeId.trim() }));
      setAssets(result.assets);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [mode, projectId, kind, recipeId]);

  useLoad(load);

  useEffect(() => {
    getJson<{ projects: ProjectSummary[] }>("/api/projects").then(({ projects: list }) => setProjects(list), () => setProjects([]));
  }, []);

  const projectName = (id: string | null) => (id ? projects.find((project) => project.id === id)?.name ?? "Project" : "Library");

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function askDelete(asset: Asset) {
    try {
      setDeleting(await getJson<UsageView>(`/api/assets/${asset.id}/usage`));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const force = deleting.usage.some((entry) => entry.kind === "export_source" || entry.kind === "export_output");
    await run(() => callTool("delete_asset_everywhere", { assetId: deleting.asset.id, confirm: true, force }));
    setDeleting(null);
  }

  return (
    <div className="mx-auto max-w-6xl p-8">
      <PageHeader
        title={mode === "active" ? "Assets" : "Archive"}
        description={
          mode === "active"
            ? "Every generated or uploaded file, with where it came from."
            : "Assets you rejected or retired. Restore them, or delete a file everywhere it is used."
        }
      />
      <div className="mb-6 flex flex-wrap gap-2" aria-label="Filters">
        <NativeSelect size="sm" value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label="Project">
          <NativeSelectOption value="">All projects</NativeSelectOption>
          {projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.name}</NativeSelectOption>)}
        </NativeSelect>
        <NativeSelect size="sm" value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Type">
          <NativeSelectOption value="">All types</NativeSelectOption>
          <NativeSelectOption value="image">Images</NativeSelectOption>
          <NativeSelectOption value="sheet">Reference sheets</NativeSelectOption>
          <NativeSelectOption value="video">Videos</NativeSelectOption>
          <NativeSelectOption value="storyboard">Storyboards</NativeSelectOption>
        </NativeSelect>
        <Input value={recipeId} onChange={(event) => setRecipeId(event.target.value)} placeholder="Recipe id" className="h-7 w-56 text-xs" aria-label="Recipe" />
      </div>
      {error ? <div className="mb-4"><Notice>{error}</Notice></div> : null}
      {assets && assets.length === 0 ? <EmptyState title={mode === "active" ? "No assets match" : "The Archive is empty"} /> : null}
      <div className="grid grid-cols-3 gap-4 lg:grid-cols-4 xl:grid-cols-5">
        {assets?.map((asset) => (
          <div key={asset.id} className="flex flex-col overflow-hidden rounded-xl border text-xs" data-testid="asset-card">
            <AssetMedia asset={asset} controls={asset.kind === "video"} className="aspect-[9/16] max-h-64 w-full" />
            <div className="space-y-1.5 p-2">
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline">{asset.kind}</Badge>
                <Badge variant="secondary">{projectName(asset.projectId)}</Badge>
              </div>
              <div className="truncate text-muted-foreground" title={asset.provenance.source === "generated" ? asset.provenance.prompt : undefined}>
                {asset.provenance.source === "generated" ? asset.provenance.recipeId : asset.provenance.source === "upload" ? `Upload: ${asset.provenance.name}` : "Export"}
              </div>
              <div className="text-muted-foreground">{formatDate(asset.createdAt)}</div>
              {asset.state.state === "archived" ? <div className="text-muted-foreground">Archived: {asset.state.reason}</div> : null}
              <div className="flex flex-wrap gap-1">
                {mode === "active" ? (
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run(() => callTool("archive_asset", { assetId: asset.id }))}>
                    <Archive /> Archive
                  </Button>
                ) : (
                  <>
                    <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run(() => callTool("archive_asset", { assetId: asset.id, restore: true }))}>
                      <ArchiveRestore /> Restore
                    </Button>
                    <Button size="xs" variant="destructive" disabled={busy} onClick={() => void askDelete(asset)}>
                      <Trash2 /> Delete everywhere
                    </Button>
                  </>
                )}
                <Button asChild size="xs" variant="ghost">
                  <a href={assetUrl(asset.id, { download: true })} aria-label="Download"><Download /></a>
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this file everywhere?</DialogTitle>
            <DialogDescription>The file is removed from disk and cannot be restored. Everything below loses it and is marked broken.</DialogDescription>
          </DialogHeader>
          {deleting ? (
            deleting.affected.length ? (
              <ul className="list-disc space-y-1 pl-5 text-xs" data-testid="affected-items">
                {deleting.affected.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing else uses this file.</p>
            )
          ) : null}
          {deleting?.usage.some((entry) => entry.kind === "export_source" || entry.kind === "export_output") ? (
            <Notice tone="warn">An export depends on this file. Deleting it breaks that export.</Notice>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Keep it</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
              <Trash2 /> Delete everywhere
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
