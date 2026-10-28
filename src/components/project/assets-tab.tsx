/**
 * Project Assets tab: the characters linked to this project with face and body candidates, the
 * project's reference sheet (wardrobe, candidates, inspection checklist, approve), linked products,
 * and every other active asset.
 * @packageDocumentation
 */
"use client";

import { ImagePlus, Link2, Mic, Sparkles, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CandidateGrid } from "@/components/cards/candidate-grid";
import { ProductForm } from "@/components/library/product-form";
import { SetForm, SetList } from "@/components/library/set-form";
import { PhotoUpload } from "@/components/references/photo-upload";
import { ReferenceSlot } from "@/components/references/reference-slot";
import { approveOwnSheet } from "@/lib/client/references";
import { AssetMedia, AssetThumb } from "@/components/media/asset-media";
import { pendingTiles, useProject } from "@/components/project/project-context";
import { SheetChecklist, sheetChecklist } from "@/components/project/sheet-checklist";
import { EmptyState } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { AUDIO_UPLOAD_TYPES, callTool, errorMessage, getJson, uploadVoice } from "@/lib/client/api";
import type { Asset, CharacterItem, GenerationProposal, LibraryView, ProjectLink } from "@/lib/client/types";
import { bibleFields, productFields } from "@/lib/client/library";
import type { ProductItem } from "@/lib/domain/library";

type CharacterLink = Extract<ProjectLink, { kind: "character" }>;

export function AssetsTab() {
  const { view, jobs } = useProject();
  const used = new Set<string>();
  for (const asset of view.assets) {
    const target = view.targets[asset.id];
    if (target && target.kind !== "loose") used.add(asset.id);
  }
  for (const { item } of view.characters) if (item.bible.references.voiceAssetId) used.add(item.bible.references.voiceAssetId);
  const others = view.assets.filter((asset) => !used.has(asset.id));
  const loosePending = pendingTiles(jobs, (target) => target.kind === "loose", (id) => view.recipes[id] ?? id);
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
            {view.products.map((product) => <ProductCard key={product.id} product={product} />)}
          </div>
        )}
      </section>
      <SetsSection />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Other assets</h2>
        {others.length || loosePending.length ? (
          <CandidateGrid assets={others} pending={loosePending} extra={(asset) => <UseAs asset={asset} />} />
        ) : (
          <p className="text-xs text-muted-foreground">Nothing else here yet. Generations from the Manual panel land here.</p>
        )}
      </section>
    </div>
  );
}

function CharacterSection({ item, link }: { item: CharacterItem; link: CharacterLink }) {
  const { projectId, view, jobs, propose, notify, refresh } = useProject();
  const [ownChecked, setOwnChecked] = useState<boolean[]>([]);
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
  const title = (id: string) => view.recipes[id] ?? id;
  const facePending = pendingTiles(jobs, (target) => target.kind === "character_reference" && target.characterId === item.id && target.slot === "face", title);
  const bodyPending = pendingTiles(jobs, (target) => target.kind === "character_reference" && target.characterId === item.id && target.slot === "body", title);
  const sheetPending = pendingTiles(jobs, (target) => target.kind === "reference_sheet" && target.characterId === item.id, title);
  const faceNext = !references.faceAssetId && faces.length === 0 && facePending.length === 0;
  const bodyNext = !!references.faceAssetId && !references.bodyAssetId && bodies.length === 0 && bodyPending.length === 0;
  const sheetNext = !!references.faceAssetId && !!references.bodyAssetId && !link.sheetAssetId && sheets.length === 0 && sheetPending.length === 0;

  async function ask(tool: "generate_face_candidates" | "generate_body_reference" | "generate_reference_sheet") {
    setBusy(true);
    try {
      const input = tool === "generate_reference_sheet" ? { projectId, characterId: item.id, wardrobe: wardrobe.trim() || undefined } : { projectId, characterId: item.id };
      propose(await callTool<GenerationProposal>(tool, input, projectId), "workspace");
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="flex items-start gap-4">
        <ReferenceSlot slot="face" assetId={references.faceAssetId} characterId={item.id} projectId={projectId} className="h-28 w-24" onLocked={refresh} onError={(text) => notify("error", text)} />
        <ReferenceSlot
          slot="body"
          assetId={references.bodyAssetId}
          characterId={item.id}
          projectId={projectId}
          className="h-28 w-20"
          canUpload={!!references.faceAssetId}
          onLocked={refresh}
          onError={(text) => notify("error", text)}
        />
        <div className="min-w-0 flex-1 text-xs">
          <Link href={`/library/${item.id}`} className="text-sm font-medium hover:underline">{item.bible.name}</Link>
          <p className="text-muted-foreground">{item.bible.ageRange} · {item.bible.vibe.join(", ")} · bible v{item.bible.version}</p>
          <p className="mt-1 line-clamp-2">{item.bible.visualCore}</p>
          {item.brokenAssetIds.length || link.brokenAssetIds.length ? <p className="mt-1 text-destructive">A reference was deleted; lock a new one.</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {!references.faceAssetId ? (
          <Button size="sm" variant={faceNext ? "default" : "outline"} disabled={busy} onClick={() => void ask("generate_face_candidates")}>
            <UserRound /> {faces.length || facePending.length ? "More face candidates" : "Generate face candidates"}
          </Button>
        ) : null}
        {!references.bodyAssetId ? (
          <Button
            size="sm"
            variant={bodyNext ? "default" : "outline"}
            disabled={busy || !references.faceAssetId}
            onClick={() => void ask("generate_body_reference")}
            title={references.faceAssetId ? undefined : "Lock the face first"}
          >
            <ImagePlus /> {bodies.length || bodyPending.length ? "More body candidates" : "Make body reference"}
          </Button>
        ) : null}
      </div>
      {faces.length || facePending.length ? (
        <div>
          <h3 className="mb-2 text-xs font-medium">Face candidates</h3>
          <CandidateGrid
            assets={faces}
            pending={facePending}
            approvedId={references.faceAssetId}
            approveLabel="Lock face"
            onApprove={async (asset) => void (await callTool("select_reference", { characterId: item.id, slot: "face", assetId: asset.id }, projectId))}
          />
        </div>
      ) : null}
      <VoiceSlot character={item} />
      {bodies.length || bodyPending.length ? (
        <div>
          <h3 className="mb-2 text-xs font-medium">Body candidates</h3>
          <CandidateGrid
            assets={bodies}
            pending={bodyPending}
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
          <Button
            size="sm"
            variant={sheetNext ? "default" : "outline"}
            disabled={busy || !references.faceAssetId || !references.bodyAssetId}
            onClick={() => void ask("generate_reference_sheet")}
            title={references.faceAssetId && references.bodyAssetId ? undefined : "Lock the face and body first"}
          >
            <Sparkles /> {sheets.length || sheetPending.length ? "Another sheet" : "Make reference sheet"}
          </Button>
          {link.sheetAssetId ? <Badge className="bg-emerald-600 text-white">Sheet approved</Badge> : null}
        </div>
        {link.sheetAssetId && !sheets.some((asset) => asset.id === link.sheetAssetId) ? (
          <AssetThumb id={link.sheetAssetId} label="Approved sheet" className="aspect-video w-full max-w-xl object-contain" />
        ) : null}
        <div className="grid grid-cols-[auto_1fr] items-start gap-4 rounded-lg border border-dashed p-3" data-testid="own-sheet">
          <PhotoUpload
            label="Use my own sheet"
            disabled={!wardrobe.trim() || checklist.some((_, index) => !ownChecked[index])}
            onFiles={async ([file]) => {
              try {
                await approveOwnSheet(file, { projectId, character: item, currentWardrobe: link.wardrobe, wardrobe });
                setOwnChecked([]);
                await refresh();
              } catch (cause) {
                notify("error", errorMessage(cause));
              }
            }}
          />
          <div className="space-y-1">
            <SheetChecklist items={sheetChecklist(wardrobe.trim() || link.wardrobe)} checked={ownChecked} onChange={setOwnChecked} />
            <p className="text-[11px] text-muted-foreground">Check your sheet against every item before uploading; it is approved for this project as soon as it uploads.</p>
          </div>
        </div>
        {sheets.length || sheetPending.length ? (
          <>
            <SheetChecklist items={checklist} checked={checked} onChange={setChecked} />
            <CandidateGrid
              assets={sheets}
              pending={sheetPending}
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

/**
 * The voice every voice-over is cloned from: a recording the creator uploads, or the audio of the
 * first approved talking clip (which generate_voice_over also takes on its own).
 */
function VoiceSlot({ character }: { character: CharacterItem }) {
  const { projectId, view, notify, refresh } = useProject();
  const [busy, setBusy] = useState(false);
  const voiceId = character.bible.references.voiceAssetId;
  const voice = voiceId ? view.assets.find((asset) => asset.id === voiceId) : undefined;
  const talkingClipApproved = view.contents.some((content) => {
    const script = view.scripts.find((entry) => entry.id === content.scriptId);
    return content.shots.some((shot) => shot.clip.state === "approved" && script?.beats[shot.beatIndex - 1]?.type === "talking");
  });

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3" data-testid="voice-slot">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium">Voice</h3>
        <span className="text-[11px] text-muted-foreground">Voice-overs on b-roll beats are read in this voice.</span>
      </div>
      {voice ? <AssetMedia asset={voice} className="max-w-md" /> : <p className="text-xs text-muted-foreground">No voice sample yet. The first voice-over takes it from the first approved talking clip, or upload a recording of the creator.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <PhotoUpload
          label={voice ? "Use another recording" : "Use a recording"}
          accept={AUDIO_UPLOAD_TYPES}
          disabled={busy}
          onFiles={([file]) =>
            run(async () => {
              const { asset } = await uploadVoice(file, projectId);
              await callTool("select_reference", { characterId: character.id, slot: "voice", assetId: asset.id, archiveSiblings: false }, projectId);
            })
          }
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !talkingClipApproved}
          title={talkingClipApproved ? "Lift the voice from the first approved talking clip" : "Approve a talking clip first"}
          onClick={() => void run(() => callTool("extract_voice_sample", { projectId, characterId: character.id }, projectId))}
        >
          <Mic /> {voice ? "Take it from the approved clip again" : "Take it from the approved clip"}
        </Button>
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

function ProductCard({ product }: { product: ProductItem }) {
  const { projectId, view, jobs, refresh, propose, notify } = useProject();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const candidates = view.assets.filter((asset) => {
    const target = view.targets[asset.id];
    return !!target && target.kind === "product_image" && target.productId === product.id && !product.imageAssetIds.includes(asset.id);
  });
  const pending = pendingTiles(jobs, (target) => target.kind === "product_image" && target.productId === product.id, (id) => view.recipes[id] ?? id);
  const photosNext = product.imageAssetIds.length === 0 && candidates.length === 0 && pending.length === 0 && !!product.appearance?.trim();

  async function generate() {
    setBusy(true);
    try {
      propose(await callTool<GenerationProposal>("generate_product_images", { projectId, productId: product.id }, projectId), "workspace");
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3 text-xs">
      <div className="flex gap-3">
        <AssetThumb id={product.imageAssetIds[0]} label="Photo" className="size-16" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <Link href={`/library/${product.id}`} className="font-medium hover:underline">{product.name}</Link>
            <div className="flex gap-1">
              <Button
                size="xs"
                variant={photosNext ? "default" : "outline"}
                disabled={busy || !product.appearance?.trim()}
                onClick={() => void generate()}
                title={product.appearance?.trim() ? undefined : "Describe the product's appearance first (Edit)"}
              >
                <ImagePlus /> {product.imageAssetIds.length || candidates.length || pending.length ? "More photos" : "Generate photos"}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setEditing((open) => !open)} aria-expanded={editing}>{editing ? "Close" : "Edit"}</Button>
            </div>
          </div>
          <p className="mt-1 text-muted-foreground">{product.appearance || "No appearance yet. Stills need it to show the product, and Generate photos is built from it."}</p>
          <ul className="mt-1 list-disc pl-4 text-muted-foreground">
            {product.allowedClaims.map((claim) => <li key={claim}>{claim}</li>)}
          </ul>
        </div>
      </div>
      {candidates.length || pending.length ? (
        <div>
          <h3 className="mb-2 font-medium">Product photo candidates</h3>
          <CandidateGrid
            assets={candidates}
            pending={pending}
            approveLabel="Use as product photo"
            className="lg:grid-cols-3"
            onApprove={async (asset) => {
              await callTool("save_product", { productId: product.id, revision: product.revision, projectId, product: { ...productFields(product), imageAssetIds: [...product.imageAssetIds, asset.id] } }, projectId);
            }}
          />
        </div>
      ) : null}
      {editing ? (
        <ProductForm
          key={product.revision}
          product={product}
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function SetsSection() {
  const { projectId, view, refresh } = useProject();
  const [adding, setAdding] = useState(false);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Sets</h2>
        <Button size="sm" variant="outline" onClick={() => setAdding((open) => !open)} aria-expanded={adding}>{adding ? "Close" : "New set from photos"}</Button>
      </div>
      {adding ? (
        <div className="max-w-xl rounded-lg border p-3">
          <SetForm
            projectId={projectId}
            onSaved={() => {
              setAdding(false);
              void refresh();
            }}
          />
        </div>
      ) : null}
      <SetList sets={view.sets} />
    </section>
  );
}

/** Turns a loose generated or uploaded image into a character's face or body, or a product's photo. */
function UseAs({ asset }: { asset: Asset }) {
  const { projectId, view, refresh, notify } = useProject();
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  if (asset.kind !== "image" && asset.kind !== "audio") return null;
  const options: { value: string; label: string; apply: () => Promise<unknown> }[] = [];
  for (const { item } of view.characters) {
    if (asset.kind === "audio") {
      if (item.bible.references.voiceAssetId !== asset.id) {
        options.push({ value: `voice:${item.id}`, label: `Voice of ${item.bible.name}`, apply: () => callTool("select_reference", { characterId: item.id, slot: "voice", assetId: asset.id, archiveSiblings: false }, projectId) });
      }
      continue;
    }
    options.push({ value: `face:${item.id}`, label: `Face of ${item.bible.name}`, apply: () => callTool("select_reference", { characterId: item.id, slot: "face", assetId: asset.id, archiveSiblings: false }, projectId) });
    if (item.bible.references.faceAssetId) {
      options.push({ value: `body:${item.id}`, label: `Body of ${item.bible.name}`, apply: () => callTool("select_reference", { characterId: item.id, slot: "body", assetId: asset.id, archiveSiblings: false }, projectId) });
    }
  }
  for (const product of view.products) {
    if (asset.kind !== "image") break;
    if (product.imageAssetIds.includes(asset.id)) continue;
    options.push({
      value: `product:${product.id}`,
      label: `Photo of ${product.name}`,
      apply: () => callTool("save_product", { productId: product.id, revision: product.revision, projectId, product: { ...productFields(product), imageAssetIds: [...product.imageAssetIds, asset.id] } }, projectId),
    });
  }
  if (!options.length) return null;

  async function apply() {
    const option = options.find((entry) => entry.value === choice);
    if (!option) return;
    setBusy(true);
    try {
      await option.apply();
      setChoice("");
      await refresh();
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-1">
      <NativeSelect size="sm" value={choice} onChange={(event) => setChoice(event.target.value)} aria-label="Use this image as" className="h-7 min-w-0 flex-1 text-xs">
        <NativeSelectOption value="">Use as…</NativeSelectOption>
        {options.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
      </NativeSelect>
      <Button size="xs" variant="outline" disabled={busy || !choice} onClick={() => void apply()}>Set</Button>
    </div>
  );
}
