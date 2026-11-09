/**
 * Documents tab, the artifact panel: the brief, each linked character's bible, and each linked
 * product card, edited in place through the same save tools the assistant uses, with every saved
 * version listed and restorable. The script is edited in the Script tab and has its history there.
 * @packageDocumentation
 */
"use client";

import { History, RotateCcw, Save } from "lucide-react";
import { useCallback, useState } from "react";
import { ProductForm } from "@/components/library/product-form";
import { useProject } from "@/components/project/project-context";
import { EmptyState, Notice } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { callTool, errorMessage } from "@/lib/client/api";
import { bibleFields } from "@/lib/client/library";
import type { CharacterItem } from "@/lib/client/types";
import { useLoad } from "@/lib/client/use-load";
import { type DocumentKind, type DocumentVersion, productContent, versionSummary } from "@/lib/domain/document";
import type { CharacterBibleFields } from "@/lib/domain/library";
import type { Brief } from "@/lib/domain/project";
import { cn } from "@/lib/utils";

type Selection = { kind: "brief" } | { kind: "bible"; id: string } | { kind: "product"; id: string };

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

export function DocumentsTab({ openScript }: { openScript: () => void }) {
  const { view, refresh } = useProject();
  const [selection, setSelection] = useState<Selection>({ kind: "brief" });
  const entries: { key: string; label: string; selection: Selection }[] = [
    { key: "brief", label: "Brief", selection: { kind: "brief" } },
    ...view.characters.map(({ item }) => ({ key: item.id, label: `Bible: ${item.bible.name}`, selection: { kind: "bible", id: item.id } as Selection })),
    ...view.products.map((product) => ({ key: product.id, label: `Product: ${product.name}`, selection: { kind: "product", id: product.id } as Selection })),
  ];
  const selectedKey = selection.kind === "brief" ? "brief" : selection.id;
  const character = selection.kind === "bible" ? view.characters.find(({ item }) => item.id === selection.id)?.item : undefined;
  const product = selection.kind === "product" ? view.products.find((entry) => entry.id === selection.id) : undefined;

  return (
    <div className="grid gap-5 lg:grid-cols-[180px_1fr]">
      <nav className="flex min-w-0 flex-row flex-wrap gap-1 lg:flex-col" aria-label="Documents">
        {entries.map((entry) => (
          <Button
            key={entry.key}
            size="sm"
            variant={entry.key === selectedKey ? "secondary" : "ghost"}
            className="max-w-full justify-start lg:w-full"
            title={entry.label}
            aria-current={entry.key === selectedKey ? "page" : undefined}
            onClick={() => setSelection(entry.selection)}
          >
            <span className="truncate">{entry.label}</span>
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="justify-start" onClick={openScript}>
          Script (Script tab)
        </Button>
      </nav>
      <div className="min-w-0 space-y-5">
        {selection.kind === "brief" ? (
          <>
            <BriefEditor key={`brief:${view.project.revision}`} />
            <VersionHistory key={`brief-history:${view.project.revision}`} kind="brief" subjectId={view.project.id} />
          </>
        ) : null}
        {character ? (
          <>
            {/* Keyed on the fields, not the revision: a face lock or voice job bumps the revision and would discard a draft. */}
            <BibleEditor key={`${character.id}:${JSON.stringify(bibleFields(character))}`} item={character} />
            <VersionHistory key={`bible-history:${character.revision}`} kind="bible" subjectId={character.id} />
          </>
        ) : null}
        {product ? (
          <>
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Product card</h2>
              <ProductForm key={`${product.id}:${JSON.stringify(productContent(product))}`} product={product} onSaved={() => void refresh()} />
            </section>
            <VersionHistory key={`product-history:${product.revision}`} kind="product" subjectId={product.id} />
          </>
        ) : null}
        {selection.kind !== "brief" && !character && !product ? <EmptyState title="This document is no longer linked to the project." /> : null}
      </div>
    </div>
  );
}

function BriefEditor() {
  const { projectId, view, refresh } = useProject();
  const brief = view.project.brief;
  const [draft, setDraft] = useState({
    productSummary: brief?.productSummary ?? "",
    audience: brief?.audience ?? "",
    platforms: (brief?.platforms ?? []).join(", "),
    tone: brief?.tone ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const set = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const next: Brief = {
        productSummary: draft.productSummary.trim(),
        audience: draft.audience.trim(),
        platforms: draft.platforms.split(",").map((platform) => platform.trim()).filter(Boolean),
        tone: draft.tone.trim(),
      };
      await callTool("save_brief", { projectId, brief: next, revision: view.project.revision }, projectId);
      await refresh();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 text-sm" aria-label="Brief">
      <h2 className="text-sm font-semibold">Brief</h2>
      {!brief ? <Notice tone="muted">No brief yet. Write it here or tell the assistant what you are selling.</Notice> : null}
      <Field label="What is being sold">
        <Textarea rows={2} maxLength={600} value={draft.productSummary} onChange={(event) => set({ productSummary: event.target.value })} />
      </Field>
      <Field label="Who buys it">
        <Textarea rows={2} maxLength={400} value={draft.audience} onChange={(event) => set({ audience: event.target.value })} />
      </Field>
      <Field label="Where it runs (comma separated)">
        <Input value={draft.platforms} onChange={(event) => set({ platforms: event.target.value })} placeholder="TikTok, Instagram Reels" />
      </Field>
      <Field label="Tone">
        <Input maxLength={200} value={draft.tone} onChange={(event) => set({ tone: event.target.value })} placeholder="Warm, direct, no hype" />
      </Field>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Button type="submit" size="sm" disabled={busy || !draft.productSummary.trim() || !draft.audience.trim() || !draft.platforms.trim() || !draft.tone.trim()}>
        <Save /> Save brief
      </Button>
    </form>
  );
}

function BibleEditor({ item }: { item: CharacterItem }) {
  const { projectId, refresh } = useProject();
  const fields = bibleFields(item);
  const [draft, setDraft] = useState({
    ...fields,
    wardrobe: fields.wardrobeDefaults.join("\n"),
    boundaryLines: fields.boundaries.join("\n"),
    vibeWords: [...fields.vibe],
    phrasesUsed: (fields.voice.phrasesUsed ?? []).join("\n"),
    phrasesAvoided: (fields.voice.phrasesAvoided ?? []).join("\n"),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setLook = (patch: Partial<typeof draft.look>) => setDraft((current) => ({ ...current, look: { ...current.look, ...patch } }));
  const setVoice = (patch: Partial<typeof draft.voice>) => setDraft((current) => ({ ...current, voice: { ...current.voice, ...patch } }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bible: CharacterBibleFields = {
        name: draft.name.trim(),
        ageRange: draft.ageRange.trim(),
        look: draft.look,
        build: draft.build.trim(),
        wardrobeDefaults: lines(draft.wardrobe),
        voice: { style: draft.voice.style, pace: draft.voice.pace, phrasesUsed: lines(draft.phrasesUsed), phrasesAvoided: lines(draft.phrasesAvoided) },
        vibe: draft.vibeWords.map((word) => word.trim()),
        backstory: draft.backstory.trim(),
        boundaries: lines(draft.boundaryLines),
        visualCore: draft.visualCore.trim(),
      };
      await callTool("save_character_bible", { characterId: item.id, revision: item.revision, bible }, projectId);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 text-sm" aria-label="Character bible">
      <h2 className="text-sm font-semibold">Character bible</h2>
      <p className="text-xs text-muted-foreground">
        The visual core starts every image prompt. Saving keeps the locked face, body, and voice; new stills and clips use the saved bible.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input maxLength={60} value={draft.name} onChange={(event) => set({ name: event.target.value })} /></Field>
        <Field label="Age range"><Input maxLength={40} value={draft.ageRange} onChange={(event) => set({ ageRange: event.target.value })} /></Field>
      </div>
      <Field label="Visual core (under 60 words)">
        <Textarea rows={3} maxLength={600} value={draft.visualCore} onChange={(event) => set({ visualCore: event.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Face"><Textarea rows={2} maxLength={300} value={draft.look.face} onChange={(event) => setLook({ face: event.target.value })} /></Field>
        <Field label="Hair"><Textarea rows={2} maxLength={200} value={draft.look.hair} onChange={(event) => setLook({ hair: event.target.value })} /></Field>
        <Field label="Skin"><Input maxLength={200} value={draft.look.skin} onChange={(event) => setLook({ skin: event.target.value })} /></Field>
        <Field label="Eyes"><Input maxLength={120} value={draft.look.eyes} onChange={(event) => setLook({ eyes: event.target.value })} /></Field>
        <Field label="Distinguishing details"><Input maxLength={300} value={draft.look.distinguishingDetails ?? ""} onChange={(event) => setLook({ distinguishingDetails: event.target.value })} /></Field>
        <Field label="Build"><Input maxLength={200} value={draft.build} onChange={(event) => set({ build: event.target.value })} /></Field>
      </div>
      <Field label="Wardrobe defaults (one to three, one per line)">
        <Textarea rows={3} value={draft.wardrobe} onChange={(event) => set({ wardrobe: event.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Voice style"><Textarea rows={2} maxLength={300} value={draft.voice.style} onChange={(event) => setVoice({ style: event.target.value })} /></Field>
        <Field label="Pace"><Input maxLength={120} value={draft.voice.pace} onChange={(event) => setVoice({ pace: event.target.value })} /></Field>
        <Field label="Phrases used (one per line)"><Textarea rows={2} value={draft.phrasesUsed} onChange={(event) => set({ phrasesUsed: event.target.value })} /></Field>
        <Field label="Phrases avoided (one per line)"><Textarea rows={2} value={draft.phrasesAvoided} onChange={(event) => set({ phrasesAvoided: event.target.value })} /></Field>
      </div>
      <Field label="Vibe (three words)">
        <div className="flex gap-2">
          {draft.vibeWords.map((word, index) => (
            <Input
              key={index}
              maxLength={40}
              value={word}
              aria-label={`Vibe word ${index + 1}`}
              onChange={(event) => set({ vibeWords: draft.vibeWords.map((entry, position) => (position === index ? event.target.value : entry)) })}
            />
          ))}
        </div>
      </Field>
      <Field label="Backstory"><Textarea rows={3} maxLength={500} value={draft.backstory} onChange={(event) => set({ backstory: event.target.value })} /></Field>
      <Field label="Boundaries (one per line)"><Textarea rows={3} value={draft.boundaryLines} onChange={(event) => set({ boundaryLines: event.target.value })} /></Field>
      {error ? <Notice>{error}</Notice> : null}
      <Button type="submit" size="sm" disabled={busy}>
        <Save /> Save bible
      </Button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

/** Every saved version of one document, newest first, with Restore on the older ones. Keyed by the record's revision, so it reloads after every save. */
function VersionHistory({ kind, subjectId }: { kind: Exclude<DocumentKind, "script">; subjectId: string }) {
  const { projectId, refresh, notify } = useProject();
  const [listing, setListing] = useState<{ current: number | null; versions: DocumentVersion[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setListing(await callTool("list_document_versions", { kind, subjectId }, projectId));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [kind, subjectId, projectId]);
  useLoad(load);

  async function restore(version: number) {
    if (!window.confirm(`Restore version ${version}? It is saved as the newest version; nothing is deleted.`)) return;
    setBusy(true);
    try {
      const result = await callTool<{ document: DocumentVersion; skippedAssetIds: string[] }>("restore_document_version", { kind, subjectId, version }, projectId);
      notify(
        result.skippedAssetIds.length ? "warn" : "ok",
        `Restored version ${version} as version ${result.document.version}.${result.skippedAssetIds.length ? ` ${result.skippedAssetIds.length} photo${result.skippedAssetIds.length === 1 ? " was" : "s were"} archived or deleted since, so ${result.skippedAssetIds.length === 1 ? "it was" : "they were"} left out.` : ""}`,
      );
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border p-3 text-xs" aria-label="Version history">
      <div className="mb-2 flex items-center gap-1.5 font-medium">
        <History className="size-3.5" /> Versions
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {listing && listing.versions.length === 0 ? <p className="text-muted-foreground">Nothing saved yet.</p> : null}
      <ul className="space-y-1.5">
        {[...(listing?.versions ?? [])].reverse().map((version) => (
          <li key={version.version} className={cn("flex items-start gap-2", version.version === listing?.current && "font-medium")}>
            <span className="shrink-0 tabular-nums">v{version.version}</span>
            <span className="min-w-0 flex-1">
              <span className="text-muted-foreground">
                {version.author === "assistant" ? "Assistant" : version.author === "user" ? "You" : "Saved"} · {new Date(version.createdAt).toLocaleString()}
                {version.restoredFrom ? ` · restored v${version.restoredFrom}` : ""}
              </span>
              <span className="block truncate">{versionSummary(version)}</span>
            </span>
            {version.version === listing?.current ? (
              <span className="shrink-0 text-muted-foreground">current</span>
            ) : (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void restore(version.version)}>
                <RotateCcw /> Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
