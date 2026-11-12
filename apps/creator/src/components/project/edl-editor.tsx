/**
 * The edit decision list in the artifact panel: the b-roll windows and the captions of a
 * take-then-cutaways Ad, as times in seconds on the take, edited in place and saved through
 * `save_edl` (each save a new version). Where each beat's line was heard is listed for reference.
 * @packageDocumentation
 */
"use client";

import { Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { useProject } from "@/components/project/project-context";
import { Notice } from "@/components/shell/page-header";
import { Button } from "@creator-lab/ui/button";
import { Input } from "@creator-lab/ui/input";
import { NativeSelect, NativeSelectOption } from "@creator-lab/ui/native-select";
import { callTool, errorMessage } from "@/lib/client/api";
import type { ContentPiece } from "@creator-lab/core/domain/content";
import type { Edl } from "@creator-lab/core/domain/edl";

type Row = { start: string; end: string };
type WindowRow = Row & { beatIndex: number };
type CaptionRow = Row & { text: string };

const seconds = (value: number) => value.toFixed(2);

export function EdlEditor({ content, edl }: { content: ContentPiece; edl: Edl }) {
  const { projectId, view, refresh, notify } = useProject();
  const script = view.scripts.find((entry) => entry.id === content.scriptId);
  const cutaways = (script?.beats ?? []).filter((beat) => beat.type !== "talking");
  const [windows, setWindows] = useState<WindowRow[]>(edl.windows.map((window) => ({ beatIndex: window.beatIndex, start: seconds(window.start), end: seconds(window.end) })));
  const [captions, setCaptions] = useState<CaptionRow[]>(edl.captions.map((cue) => ({ text: cue.text, start: seconds(cue.start), end: seconds(cue.end) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = content.take.state !== "approved" || content.take.assetId !== edl.take.assetId;
  const scriptChanged = edl.scriptVersion !== content.scriptVersion;
  const estimated = edl.beats.filter((span) => span.estimated).map((span) => span.beatIndex);

  async function run(input: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const saved = await callTool<{ version: number | null }>("save_edl", { contentId: content.id, ...input }, projectId);
      notify("ok", saved.version ? `${done} as version ${saved.version}. Export again to see it; nothing is regenerated.` : "Nothing changed.");
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    void run(
      {
        windows: windows.map((row) => ({ beatIndex: row.beatIndex, start: Number(row.start), end: Number(row.end) })),
        captions: captions.map((row) => ({ text: row.text.trim(), start: Number(row.start), end: Number(row.end) })),
      },
      "Saved the edit decision list",
    );
  }

  const setWindow = (index: number, patch: Partial<WindowRow>) => setWindows((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  const setCaption = (index: number, patch: Partial<CaptionRow>) => setCaptions((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  const time = (label: string, value: string, onChange: (value: string) => void) => (
    <Input className="w-24" type="number" min={0} max={edl.take.durationSeconds} step={0.05} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
  );

  return (
    <form onSubmit={save} className="space-y-4 text-sm" aria-label="Edit decision list">
      <div>
        <h2 className="text-sm font-semibold">Edit decision list: {content.title}</h2>
        <p className="text-xs text-muted-foreground">
          Times are seconds on the {edl.take.durationSeconds.toFixed(2)} s talking recording. In a window the picture is that beat&apos;s approved clip from its first frame; the sound is always the recording&apos;s. Export again (Export tab, Recording with cutaways) to see a change.
        </p>
      </div>
      {stale ? <Notice tone="warn">This list was drafted for another recording. Transcribe the approved recording and draft it again.</Notice> : null}
      {!stale && scriptChanged ? (
        <Notice tone="warn">
          The script changed since this list was drafted (version {edl.scriptVersion}, now {content.scriptVersion}). Draft it again from the transcript before exporting.
        </Notice>
      ) : null}
      {estimated.length ? (
        <Notice tone="muted">
          {estimated.length === 1 ? `Beat ${estimated[0]} was` : `Beats ${estimated.join(", ")} were`} placed by estimate: none of {estimated.length === 1 ? "its" : "their"} words was heard in the recording. Check those windows and captions.
        </Notice>
      ) : null}
      <section className="space-y-2" aria-label="Windows">
        <h3 className="text-xs font-medium">B-roll windows</h3>
        {windows.length === 0 ? <p className="text-xs text-muted-foreground">No windows: the recording plays through.</p> : null}
        {windows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <NativeSelect value={String(row.beatIndex)} aria-label={`Window ${index + 1} beat`} onChange={(event) => setWindow(index, { beatIndex: Number(event.target.value) })}>
              {cutaways.map((beat) => (
                <NativeSelectOption key={beat.index} value={String(beat.index)}>
                  Beat {beat.index} ({beat.type === "broll" ? "b-roll" : "text card"})
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {time(`Window ${index + 1} start`, row.start, (value) => setWindow(index, { start: value }))}
            <span className="text-xs text-muted-foreground">to</span>
            {time(`Window ${index + 1} end`, row.end, (value) => setWindow(index, { end: value }))}
            <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove window ${index + 1}`} onClick={() => setWindows((rows) => rows.filter((_, position) => position !== index))}>
              <Trash2 />
            </Button>
          </div>
        ))}
        {cutaways.length ? (
          <Button type="button" size="xs" variant="outline" onClick={() => setWindows((rows) => [...rows, { beatIndex: cutaways[0].index, start: "0.00", end: "1.00" }])}>
            <Plus /> Add a window
          </Button>
        ) : null}
      </section>
      <section className="space-y-2" aria-label="Captions">
        <h3 className="text-xs font-medium">Captions</h3>
        {captions.map((row, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            {time(`Caption ${index + 1} start`, row.start, (value) => setCaption(index, { start: value }))}
            <span className="text-xs text-muted-foreground">to</span>
            {time(`Caption ${index + 1} end`, row.end, (value) => setCaption(index, { end: value }))}
            <Input className="min-w-48 flex-1" maxLength={80} aria-label={`Caption ${index + 1} text`} value={row.text} onChange={(event) => setCaption(index, { text: event.target.value })} />
            <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove caption ${index + 1}`} onClick={() => setCaptions((rows) => rows.filter((_, position) => position !== index))}>
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button type="button" size="xs" variant="outline" onClick={() => setCaptions((rows) => [...rows, { text: "", start: "0.00", end: "1.00" }])}>
          <Plus /> Add a caption
        </Button>
      </section>
      {edl.beats.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Where each line was heard</summary>
          <ul className="mt-1 space-y-0.5">
            {edl.beats.map((span) => (
              <li key={span.beatIndex}>
                Beat {span.beatIndex}: {seconds(span.start)} to {seconds(span.end)} s · {span.estimated ? "estimated, no word heard" : `${span.matchedWords} of ${span.totalWords} words`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {error ? <Notice>{error}</Notice> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          <Save /> Save list
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run({ draft: true }, "Drafted the list again from the transcript")}>
          <RotateCcw /> Draft again from the transcript
        </Button>
      </div>
    </form>
  );
}
