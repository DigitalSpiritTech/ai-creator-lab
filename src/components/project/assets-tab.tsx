/**
 * Project Assets tab: the characters linked to this project with face and body candidates, the
 * project's reference sheet (wardrobe, candidates, inspection checklist, approve), linked products,
 * and every other active asset.
 * @packageDocumentation
 */
"use client";

import { Link2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CandidateGrid } from "@/components/cards/candidate-grid";
import { AssetThumb } from "@/components/media/asset-media";
import { useProject } from "@/components/project/project-context";
import { SheetChecklist, sheetChecklist } from "@/components/project/sheet-checklist";
import { EmptyState } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { callTool, errorMessage, getJson } from "@/lib/client/api";
import type { Asset, CharacterItem, GenerationProposal, LibraryView, ProjectLink } from "@/lib/client/types";
import { bibleFields, productFields } from "@/lib/client/library";

type CharacterLink = Extract<ProjectLink, { kind: "character" }>;

export function AssetsTab() {
  const { view } = useProject();
  const used = new Set<string>();
  for (const asset of view.assets) {
    const target = view.targets[asset.id];
    if (target && target.kind !== "loose") used.add(asset.id);
  }
  const others = view.assets.filter((asset) => !used.has(asset.id));
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Characters</h2>
          <LinkFromLibrary kind="character" />
        </div>
        {view.characters.length === 0 ? (
          <EmptyState title="No character linked">Ask the assistant to build a character bible, or link one from the Library.</EmptyState>
        ) : (
          view.characters.map(({ item, link }) => <CharacterSection key={item.id} item={item} link={link as CharacterLink} />)
        )}
      </section>
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Products</h2>
          <LinkFromLibrary kind="product" />
        </div>
        {view.products.length === 0 ? (
          <p className="text-xs text-muted-foreground">No product linked yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {view.products.map((product) => (
              <div key={product.id} className="flex gap-3 rounded-lg border p-3 text-xs">
                <AssetThumb id={product.imageAssetIds[0]} label="Photo" className="size-16" />
                <div>
                  <Link href={`/library/${product.id}`} className="font-medium hover:underline">{product.name}</Link>
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                    {product.allowedClaims.map((claim) => <li key={claim}>{claim}</li>)}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Other assets</h2>
        {others.length ? <CandidateGrid assets={others} /> : <p className="text-xs text-muted-foreground">Nothing else here yet.</p>}
      </section>
    </div>
  );
}

function CharacterSection({ item, link }: { item: CharacterItem; link: CharacterLink }) {
  const { projectId, view, propose, notify } = useProject();
  const [wardrobe, setWardrobe] = useState(link.wardrobe ?? item.bible.wardrobeDefaults[0] ?? "");
  const [busy, setBusy] = useState(false);
  const checklist = sheetChecklist(link.wardrobe);
  const [checked, setChecked] = useState<boolean[]>([]);
  const byTarget = (match: (target: NonNullable<(typeof view.targets)[string]>) => boolean): Asset[] =>
    view.assets.filter((asset) => {
      const target = view.targets[asset.id];
      return !!target && match(target);
    });
  const faces = byTarget((target) => target.kind === "character_reference" && target.characterId === item.id && target.slot === "face");
  const bodies = byTarget((target) => target.kind === "character_reference" && target.characterId === item.id && target.slot === "body");
  const sheets = byTarget((target) => target.kind === "reference_sheet" && target.characterId === item.id);
  const references = item.bible.references;

  async function makeSheet() {
    setBusy(true);
    try {
      propose(
        await callTool<GenerationProposal>("generate_reference_sheet", { projectId, characterId: item.id, wardrobe: wardrobe.trim() || undefined }, projectId),
        "workspace",
      );
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="flex items-start gap-4">
        <AssetThumb id={references.faceAssetId} label="Face" className="h-28 w-24" />
        <AssetThumb id={references.bodyAssetId} label="Body" className="h-28 w-20" />
        <div className="min-w-0 flex-1 text-xs">
          <Link href={`/library/${item.id}`} className="text-sm font-medium hover:underline">{item.bible.name}</Link>
          <p className="text-muted-foreground">{item.bible.ageRange} · {item.bible.vibe.join(", ")} · bible v{item.bible.version}</p>
          <p className="mt-1 line-clamp-2">{item.bible.visualCore}</p>
          {item.brokenAssetIds.length || link.brokenAssetIds.length ? <p className="mt-1 text-destructive">A reference was deleted; lock a new one.</p> : null}
        </div>
      </div>
      {faces.length ? (
        <div>
          <h3 className="mb-2 text-xs font-medium">Face candidates</h3>
          <CandidateGrid
            assets={faces}
            approvedId={references.faceAssetId}
            approveLabel="Lock face"
            onApprove={async (asset) => void (await callTool("select_reference", { characterId: item.id, slot: "face", assetId: asset.id }, projectId))}
          />
        </div>
      ) : null}
      {bodies.length ? (
        <div>
          <h3 className="mb-2 text-xs font-medium">Body candidates</h3>
          <CandidateGrid
            assets={bodies}
            approvedId={references.bodyAssetId}
            approveLabel="Lock body"
            onApprove={async (asset) => void (await callTool("select_reference", { characterId: item.id, slot: "body", assetId: asset.id }, projectId))}
          />
        </div>
      ) : null}
      <div className="space-y-3">
        <h3 className="text-xs font-medium">Reference sheet for this project</h3>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect size="sm" value={item.bible.wardrobeDefaults.includes(wardrobe) ? wardrobe : ""} onChange={(event) => event.target.value && setWardrobe(event.target.value)} aria-label="Wardrobe from the bible">
            <NativeSelectOption value="">Custom wardrobe</NativeSelectOption>
            {item.bible.wardrobeDefaults.map((entry) => <NativeSelectOption key={entry} value={entry}>{entry}</NativeSelectOption>)}
          </NativeSelect>
          <Input value={wardrobe} onChange={(event) => setWardrobe(event.target.value)} className="h-7 max-w-sm text-xs" aria-label="Wardrobe" maxLength={300} />
          <Button size="sm" variant="outline" disabled={busy || !references.faceAssetId || !references.bodyAssetId} onClick={() => void makeSheet()} title={references.faceAssetId && references.bodyAssetId ? undefined : "Lock the face and body first"}>
            <Sparkles /> Make reference sheet
          </Button>
          {link.sheetAssetId ? <Badge className="bg-emerald-600 text-white">Sheet approved</Badge> : null}
        </div>
        {link.sheetAssetId && !sheets.some((asset) => asset.id === link.sheetAssetId) ? (
          <AssetThumb id={link.sheetAssetId} label="Approved sheet" className="aspect-video w-full max-w-xl" />
        ) : null}
        {sheets.length ? (
          <>
            <SheetChecklist items={checklist} checked={checked} onChange={setChecked} />
            <CandidateGrid
              assets={sheets}
              approvedId={link.sheetAssetId}
              approveLabel="Approve sheet"
              className="lg:grid-cols-2"
              inspection={<SheetChecklist items={checklist} checked={checked} onChange={setChecked} />}
              onApprove={async (asset) => {
                if (checklist.some((_, index) => !checked[index])) throw new Error("Check every item on the inspection checklist against the full-size sheet first.");
                await callTool("approve", { kind: "sheet", assetId: asset.id, projectId, characterId: item.id }, projectId);
                setChecked([]);
              }}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function LinkFromLibrary({ kind }: { kind: "character" | "product" }) {
  const { projectId, view, refresh, notify } = useProject();
  const [library, setLibrary] = useState<LibraryView | null>(null);
  const [choice, setChoice] = useState("");
  useEffect(() => {
    getJson<LibraryView>(`/api/library?kind=${kind}`).then(setLibrary, () => setLibrary(null));
  }, [kind]);
  const linked = new Set([...view.characters.map(({ item }) => item.id), ...view.products.map((product) => product.id)]);
  const options = (library?.items ?? []).filter((item) => !linked.has(item.id));
  if (!options.length) return null;

  async function link() {
    const item = options.find((entry) => entry.id === choice);
    if (!item) return;
    try {
      if (item.kind === "character") {
        await callTool("save_character_bible", { characterId: item.id, revision: item.revision, projectId, bible: bibleFields(item) }, projectId);
      } else if (item.kind === "product") {
        await callTool("save_product", { productId: item.id, revision: item.revision, projectId, product: productFields(item) }, projectId);
      }
      setChoice("");
      await refresh();
    } catch (cause) {
      notify("error", errorMessage(cause));
    }
  }

  return (
    <div className="flex items-center gap-2">
      <NativeSelect size="sm" value={choice} onChange={(event) => setChoice(event.target.value)} aria-label={`Link a ${kind}`}>
        <NativeSelectOption value="">Link a {kind} from the Library</NativeSelectOption>
        {options.map((item) => (
          <NativeSelectOption key={item.id} value={item.id}>{item.kind === "character" ? item.bible.name : item.name}</NativeSelectOption>
        ))}
      </NativeSelect>
      <Button size="sm" variant="outline" disabled={!choice} onClick={() => void link()}>
        <Link2 /> Link
      </Button>
    </div>
  );
}
