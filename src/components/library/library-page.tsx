/**
 * Library: Characters, Products, and Sets reused across projects, with the projects each is linked to.
 * @packageDocumentation
 */
"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { AssetThumb } from "@/components/media/asset-media";
import { ProductForm } from "@/components/library/product-form";
import { SetForm } from "@/components/library/set-form";
import { EmptyState, Notice, PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLoad } from "@/lib/client/use-load";
import { errorMessage, getJson } from "@/lib/client/api";
import type { LibraryItem, LibraryView } from "@/lib/client/types";

const KINDS = [
  { kind: "character", label: "Characters" },
  { kind: "product", label: "Products" },
  { kind: "set", label: "Sets" },
] as const;

export function LibraryPage() {
  const [kind, setKind] = useState<(typeof KINDS)[number]["kind"]>("character");
  const [view, setView] = useState<LibraryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await getJson<LibraryView>(`/api/library?kind=${kind}`));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [kind]);

  useLoad(load);

  const projectNames = new Map((view?.projects ?? []).map((project) => [project.id, project.name]));
  const linksFor = (item: LibraryItem) => (view?.links ?? []).filter((link) => link.itemId === item.id);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <PageHeader
        title="Library"
        description="Approved characters, products, and sets you reuse across projects."
        actions={kind === "product" || kind === "set" ? <Button size="sm" onClick={() => setCreating((open) => !open)}>{creating ? "Close" : kind === "product" ? "New product" : "New set from photos"}</Button> : null}
      />
      <div className="mb-6 flex gap-1" role="tablist">
        {KINDS.map((entry) => (
          <Button key={entry.kind} size="sm" role="tab" aria-selected={kind === entry.kind} variant={kind === entry.kind ? "secondary" : "ghost"} onClick={() => { setKind(entry.kind); setCreating(false); }}>
            {entry.label}
          </Button>
        ))}
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {kind === "product" && creating ? (
        <div className="mb-6 max-w-2xl rounded-xl border p-4">
          <ProductForm onSaved={() => { setCreating(false); void load(); }} />
        </div>
      ) : null}
      {kind === "set" && creating ? (
        <div className="mb-6 max-w-2xl rounded-xl border p-4">
          <SetForm onSaved={() => { setCreating(false); void load(); }} />
        </div>
      ) : null}
      {view && view.items.length === 0 ? (
        <EmptyState title={`No ${KINDS.find((entry) => entry.kind === kind)!.label.toLowerCase()} yet`}>
          {kind === "character"
            ? "Characters are created with the assistant in a project: bible, face lock, then body reference."
            : kind === "product"
              ? "Add a product with its photos, link, and the claims an ad may make."
              : "Add a set from photos of a real location: a kitchen counter, a car interior, a boardroom."}
        </EmptyState>
      ) : null}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
        {view?.items.map((item) => (
          <Link key={item.id} href={`/library/${item.id}`} className="flex gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/40">
            {item.kind === "character" ? (
              <>
                <AssetThumb id={item.bible.references.faceAssetId} label="Face" className="h-24 w-20" />
                <AssetThumb id={item.bible.references.bodyAssetId} label="Body" className="h-24 w-16" />
              </>
            ) : (
              <AssetThumb id={item.imageAssetIds[0]} label="Image" className="size-24" />
            )}
            <div className="min-w-0 text-xs">
              <div className="text-sm font-medium">{item.kind === "character" ? item.bible.name : item.name}</div>
              {item.kind === "character" ? <p className="text-muted-foreground">{item.bible.ageRange} · bible v{item.bible.version}</p> : null}
              {item.kind === "product" ? <p className="text-muted-foreground">{item.allowedClaims.length} allowed claim{item.allowedClaims.length === 1 ? "" : "s"}</p> : null}
              <div className="mt-2 flex flex-wrap gap-1">
                {linksFor(item).map((link) => <Badge key={link.projectId} variant="outline">{projectNames.get(link.projectId) ?? "Project"}</Badge>)}
              </div>
              {item.brokenAssetIds.length ? <p className="mt-1 text-destructive">A reference was deleted</p> : null}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
