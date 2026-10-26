/**
 * Export tab: clip order (`set_cut_order`), mute and captions toggles, Export (`assemble_ad`), and a player with
 * download and source record for finished exports.
 * @packageDocumentation
 */
"use client";

import { ArrowDown, ArrowUp, Download, Film } from "lucide-react";
import { useState } from "react";
import { AssetMedia } from "@/components/media/asset-media";
import { useProject } from "@/components/project/project-context";
import { EmptyState, Notice } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { assetUrl, callTool, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/client/format";
import type { ExportRecord } from "@/lib/client/types";

export function ExportTab() {
  const { projectId, view, refresh } = useProject();
  const [contentId, setContentId] = useState<string | null>(view.contents[0]?.id ?? null);
  const content = view.contents.find((entry) => entry.id === contentId) ?? view.contents[0];
  const [mute, setMute] = useState<boolean | null>(null);
  const [captions, setCaptions] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  if (!content) return <EmptyState title="Nothing to export yet">Plan shots and approve a clip for every beat first.</EmptyState>;

  const script = view.scripts.find((entry) => entry.id === content.scriptId);
  const shots = new Map(content.shots.map((shot) => [shot.id, shot]));
  const ready = content.shots.every((shot) => shot.clip.state === "approved");
  const exports = view.exports.filter((record) => record.contentId === content.id);
  const finished = exports.find((record) => record.status === "completed");
  const muteValue = mute ?? content.cut.mute;
  const captionsValue = captions ?? content.cut.captions;

  async function move(position: number, by: number) {
    if (!content) return;
    const order = [...content.cut.order];
    const [shotId] = order.splice(position, 1);
    order.splice(position + by, 0, shotId);
    setBusy(true);
    setResult(null);
    try {
      await callTool("set_cut_order", { contentId: content.id, shotIds: order }, projectId);
      await refresh();
    } catch (cause) {
      setResult({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function exportAd() {
    if (!content) return;
    setBusy(true);
    setResult(null);
    try {
      const { export: record } = await callTool<{ export: ExportRecord }>("assemble_ad", { contentId: content.id, mute: muteValue, captions: captionsValue }, projectId);
      setResult(
        record.status === "completed"
          ? { tone: "ok", text: "Export finished." }
          : record.status === "failed"
            ? { tone: "error", text: record.error }
            : { tone: "ok", text: `Rendering ${record.sources.length} clips in order.` },
      );
      await refresh();
    } catch (cause) {
      setResult({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {view.contents.length > 1 ? (
        <NativeSelect value={content.id} onChange={(event) => setContentId(event.target.value)} aria-label="Content piece">
          {view.contents.map((entry) => <NativeSelectOption key={entry.id} value={entry.id}>{entry.title}</NativeSelectOption>)}
        </NativeSelect>
      ) : null}
      <section>
        <h2 className="mb-2 text-sm font-semibold">Order</h2>
        <ol className="space-y-1 text-xs">
          {content.cut.order.map((shotId, position) => {
            const shot = shots.get(shotId);
            const beat = shot ? script?.beats[shot.beatIndex - 1] : undefined;
            return (
              <li key={shotId} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                <span className="w-5 text-muted-foreground">{position + 1}</span>
                <span className="font-medium">Beat {shot?.beatIndex}</span>
                <span className="truncate text-muted-foreground">{beat?.onScreenText || beat?.visual}</span>
                <span className="ml-auto">{shot?.clip.state === "approved" ? <Badge variant="secondary">Clip approved</Badge> : <Badge variant="outline">No clip</Badge>}</span>
                <Button size="icon-xs" variant="ghost" disabled={busy || position === 0} onClick={() => void move(position, -1)} aria-label={`Move beat ${shot?.beatIndex} earlier`}><ArrowUp /></Button>
                <Button size="icon-xs" variant="ghost" disabled={busy || position === content.cut.order.length - 1} onClick={() => void move(position, 1)} aria-label={`Move beat ${shot?.beatIndex} later`}><ArrowDown /></Button>
              </li>
            );
          })}
        </ol>
      </section>
      <section className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={muteValue} onChange={(event) => setMute(event.target.checked)} /> Mute audio
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={captionsValue} onChange={(event) => setCaptions(event.target.checked)} /> Burn on-screen text
        </label>
        <Button onClick={() => void exportAd()} disabled={busy || !ready} title={ready ? undefined : "Every beat needs an approved clip"}>
          <Film /> Export 1080 x 1920
        </Button>
      </section>
      {!ready ? <Notice tone="muted">Every beat needs an approved clip before export.</Notice> : null}
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
      {finished && finished.status === "completed" ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Latest export</h2>
          <AssetMedia asset={view.assets.find((asset) => asset.id === finished.assetId) ?? { id: finished.assetId, kind: "export", mime: "video/mp4", video: undefined }} controls className="aspect-[9/16] w-64 rounded-lg" />
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <a href={assetUrl(finished.assetId, { download: true })}><Download /> Download</a>
            </Button>
          </div>
          <SourceRecord record={finished} />
        </section>
      ) : null}
      {exports.length ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Exports</h2>
          <ul className="space-y-1 text-xs">
            {exports.map((record) => (
              <li key={record.id} className="flex gap-2">
                <Badge variant={record.status === "failed" ? "destructive" : "secondary"}>{record.status}</Badge>
                {formatDate(record.createdAt)} · {record.sources.length} clips · {record.options.mute ? "muted" : "with audio"} · {record.options.captions ? "captions" : "no captions"}
                {record.brokenAssetIds.length ? <span className="text-destructive">source deleted</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function SourceRecord({ record }: { record: ExportRecord }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">Source record</summary>
      <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
        {record.sources.map((source) => (
          <li key={source.shotId}>beat {source.beatIndex} · clip {source.assetId.slice(0, 8)} · sha256 {source.sha256.slice(0, 12)}</li>
        ))}
      </ul>
    </details>
  );
}
