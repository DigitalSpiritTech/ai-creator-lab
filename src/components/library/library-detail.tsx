/**
 * One Library item. Characters show the bible, the locked face and body, wardrobe defaults, and per
 * project the wardrobe and approved reference sheet; products are editable; sets are listed.
 * @packageDocumentation
 */
"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ProductForm } from "@/components/library/product-form";
import { AssetThumb } from "@/components/media/asset-media";
import { Notice, PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { callTool, errorMessage, getJson } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { bibleFields, productFields } from "@/lib/client/library";
import type { LibraryItemView } from "@/lib/client/types";

type DetailView = LibraryItemView;

export function LibraryDetail({ itemId }: { itemId: string }) {
  const [view, setView] = useState<DetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectChoice, setProjectChoice] = useState("");

  const load = useCallback(async () => {
    try {
      setView(await getJson<DetailView>(`/api/library/${itemId}`));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [itemId]);

  useLoad(load);

  if (!view) return <div className="p-8">{error ? <Notice>{error}</Notice> : <p className="text-sm text-muted-foreground">Loading…</p>}</div>;
  const { item } = view;
  const name = item.kind === "character" ? item.bible.name : item.name;
  const projectName = (id: string) => view.projects.find((project) => project.id === id)?.name ?? "Project";

  async function linkToProject() {
    if (!projectChoice) return;
    try {
      if (item.kind === "character") {
        await callTool("save_character_bible", { characterId: item.id, revision: item.revision, projectId: projectChoice, bible: bibleFields(item) }, projectChoice);
      } else if (item.kind === "product") {
        await callTool("save_product", { productId: item.id, revision: item.revision, projectId: projectChoice, product: productFields(item) }, projectChoice);
      }
      setProjectChoice("");
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const unlinked = view.projects.filter((project) => !project.linked);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8">
      <PageHeader
        title={name}
        description={item.kind === "character" ? `Character · bible version ${item.bible.version}` : item.kind === "product" ? "Product" : "Set"}
        actions={
          item.kind !== "set" && unlinked.length ? (
            <>
              <NativeSelect size="sm" value={projectChoice} onChange={(event) => setProjectChoice(event.target.value)} aria-label="Project">
                <NativeSelectOption value="">Link to a project</NativeSelectOption>
                {unlinked.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.name}</NativeSelectOption>)}
              </NativeSelect>
              <Button size="sm" variant="outline" disabled={!projectChoice} onClick={() => void linkToProject()}>Link</Button>
            </>
          ) : null
        }
      />
      <div className="text-xs"><Link href="/library" className="text-muted-foreground hover:underline">Back to Library</Link></div>
      {error ? <Notice>{error}</Notice> : null}
      {item.brokenAssetIds.length ? <Notice tone="warn">A reference this item used was deleted. Lock a new one in a project.</Notice> : null}
      {item.kind === "character" ? (
        <>
          <section className="flex gap-4">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Face (identity reference)</div>
              <AssetThumb id={item.bible.references.faceAssetId} label="Face" className="h-56 w-44" />
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Body reference</div>
              <AssetThumb id={item.bible.references.bodyAssetId} label="Body" className="h-56 w-36" />
            </div>
            <dl className="grid flex-1 grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Age range</dt><dd>{item.bible.ageRange}</dd>
              <dt className="text-muted-foreground">Face</dt><dd>{item.bible.look.face}</dd>
              <dt className="text-muted-foreground">Hair</dt><dd>{item.bible.look.hair}</dd>
              <dt className="text-muted-foreground">Skin and eyes</dt><dd>{item.bible.look.skin}; {item.bible.look.eyes}</dd>
              {item.bible.look.distinguishingDetails ? (<><dt className="text-muted-foreground">Details</dt><dd>{item.bible.look.distinguishingDetails}</dd></>) : null}
              <dt className="text-muted-foreground">Build</dt><dd>{item.bible.build}</dd>
              <dt className="text-muted-foreground">Voice</dt><dd>{item.bible.voice.style}; {item.bible.voice.pace}</dd>
              <dt className="text-muted-foreground">Vibe</dt><dd>{item.bible.vibe.join(", ")}</dd>
              <dt className="text-muted-foreground">Backstory</dt><dd>{item.bible.backstory}</dd>
              <dt className="text-muted-foreground">Boundaries</dt><dd>{item.bible.boundaries.join("; ") || "None"}</dd>
              <dt className="text-muted-foreground">Visual core</dt><dd>{item.bible.visualCore}</dd>
            </dl>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Wardrobe</h2>
            <div className="flex flex-wrap gap-2">
              {item.bible.wardrobeDefaults.map((entry) => <Badge key={entry} variant="outline">{entry}</Badge>)}
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Projects</h2>
            {view.links.length === 0 ? <p className="text-xs text-muted-foreground">Not linked to a project yet.</p> : null}
            <div className="grid grid-cols-2 gap-3">
              {view.links.map((link) =>
                link.kind === "character" ? (
                  <Link key={link.projectId} href={`/projects/${link.projectId}`} className="space-y-2 rounded-xl border p-3 text-xs hover:bg-muted/40">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{projectName(link.projectId)}</span>
                      {link.sheetAssetId ? <Badge className="bg-emerald-600 text-white">Sheet approved</Badge> : <Badge variant="outline">No sheet yet</Badge>}
                    </div>
                    <div className="text-muted-foreground">Wardrobe: {link.wardrobe ?? "not chosen"}</div>
                    {link.sheetAssetId ? <AssetThumb id={link.sheetAssetId} label="Reference sheet" className="aspect-video w-full" /> : null}
                  </Link>
                ) : null,
              )}
            </div>
          </section>
        </>
      ) : null}
      {item.kind === "product" ? (
        <section className="grid grid-cols-[1fr_auto] gap-6">
          <ProductForm key={item.revision} product={item} onSaved={() => void load()} />
          <div className="w-56 text-xs">
            <h2 className="mb-2 text-sm font-semibold">Projects</h2>
            {view.links.length ? (
              <ul className="space-y-1">{view.links.map((link) => <li key={link.projectId}><Link className="hover:underline" href={`/projects/${link.projectId}`}>{projectName(link.projectId)}</Link></li>)}</ul>
            ) : <p className="text-muted-foreground">Not linked yet.</p>}
          </div>
        </section>
      ) : null}
      {item.kind === "set" ? (
        <section className="space-y-3 text-sm">
          <p>{item.notes || "No notes."}</p>
          <div className="flex flex-wrap gap-2">{item.imageAssetIds.map((id) => <AssetThumb key={id} id={id} label="Set reference" className="size-32" />)}</div>
        </section>
      ) : null}
    </div>
  );
}
