/**
 * Script tab: the beats table with editable fields saved through `save_script` as a new version,
 * version history, and planning shots for the current version.
 * @packageDocumentation
 */
"use client";

import { ArrowDown, ArrowUp, History, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useProject } from "@/components/project/project-context";
import { EmptyState, Notice } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { callTool, errorMessage, getJson } from "@/lib/client/api";
import type { GenerationProposal } from "@/lib/client/types";
import type { BeatInput, Script } from "@/lib/domain/script";

type DraftBeat = Required<Omit<BeatInput, "notes">> & { notes: string };

const BEAT_TYPES = ["talking", "broll", "textcard"] as const;
const PURPOSES = ["hook", "problem", "reveal", "proof", "cta"] as const;

function toDraft(script: Script): DraftBeat[] {
  return script.beats.map((beat) => ({
    type: beat.type,
    purpose: beat.purpose,
    spokenLine: beat.spokenLine,
    onScreenText: beat.onScreenText,
    visual: beat.visual,
    setting: beat.setting,
    productVisible: beat.productVisible,
    durationSeconds: beat.durationSeconds,
    notes: beat.notes,
  }));
}

function blankBeat(): DraftBeat {
  return {
    type: "broll",
    purpose: "proof",
    spokenLine: "",
    onScreenText: "",
    visual: "Close-up of the bottle on a bright kitchen counter by a window",
    setting: "",
    productVisible: true,
    durationSeconds: 5,
    notes: "",
  };
}

const STARTER: DraftBeat[] = [
  {
    type: "talking",
    purpose: "hook",
    spokenLine: "I stopped buying iced coffee on the way to work.",
    onScreenText: "Cold for 24 hours",
    visual: "Avery Lane at a bright kitchen counter, holding the bottle toward camera",
    setting: "Bright kitchen counter by a window",
    productVisible: true,
    durationSeconds: 5,
    notes: "",
  },
];

export function ScriptTab() {
  const { projectId, view, refresh, notify, propose } = useProject();
  const scripts = view.scripts;
  const [scriptId, setScriptId] = useState<string | null>(scripts[0]?.id ?? null);
  const script = scripts.find((entry) => entry.id === scriptId) ?? scripts[0] ?? null;
  const [title, setTitle] = useState(script?.title ?? "Ridgeline 32 oz, first ad");
  const [beats, setBeats] = useState<DraftBeat[]>(script ? toDraft(script) : STARTER);
  const [baseVersion, setBaseVersion] = useState(script?.version);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [versions, setVersions] = useState<Script[] | null>(null);

  // Reload the draft when the saved script changes underneath (a new version from the assistant).
  const savedKey = script ? `${script.id}:${script.version}` : "none";
  const [loadedKey, setLoadedKey] = useState(savedKey);
  if (savedKey !== loadedKey) {
    setLoadedKey(savedKey);
    if (script) {
      setTitle(script.title);
      setBeats(toDraft(script));
      setBaseVersion(script.version);
      setVersions(null);
    }
  }

  const content = useMemo(() => (script ? view.contents.find((entry) => entry.scriptId === script.id) : undefined), [script, view.contents]);
  const dirty = !script || JSON.stringify(toDraft(script)) !== JSON.stringify(beats) || title !== script.title;

  function update(index: number, patch: Partial<DraftBeat>) {
    setBeats((current) => current.map((beat, position) => (position === index ? { ...beat, ...patch } : beat)));
  }

  function move(index: number, by: number) {
    setBeats((current) => {
      const next = [...current];
      const [beat] = next.splice(index, 1);
      next.splice(index + by, 0, beat);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await callTool<{ script: Script; change: { stillInvalidated: number[]; clipInvalidated: number[] } | null }>(
        "save_script",
        { projectId, scriptId: script?.id, baseVersion: script ? baseVersion : undefined, title: title.trim(), beats },
        projectId,
      );
      setScriptId(result.script.id);
      const lost = result.change ? [...new Set([...result.change.stillInvalidated, ...result.change.clipInvalidated])] : [];
      setMessage({
        tone: lost.length ? "warn" : "ok",
        text: `Saved version ${result.script.version}.${lost.length ? ` Beats ${lost.join(", ")} need new approvals.` : ""}`,
      });
      await refresh();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function planShots() {
    if (!script) return;
    setBusy(true);
    try {
      await callTool("plan_shots", { projectId, scriptId: script.id, contentId: content?.id }, projectId);
      await refresh();
      setMessage({ tone: "ok", text: content ? "Shots updated to the current script." : "Shots planned: one per beat. Open the Shots tab." });
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  /** Withdraws approvals from this beat on, then opens the beat's compose proposal at the gate. */
  async function regenerateFrom(beatIndex: number) {
    if (!content) return;
    if (!window.confirm(`Withdraw the approved stills and clips of beat ${beatIndex} and every later beat? Candidates stay.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { resetBeats } = await callTool<{ resetBeats: number[] }>("reset_shots", { contentId: content.id, fromBeatIndex: beatIndex }, projectId);
      propose(await callTool<GenerationProposal>("compose_still", { contentId: content.id, beatIndex }, projectId), "workspace");
      setMessage({
        tone: "ok",
        text: `${resetBeats.length ? `Approvals withdrawn for beats ${resetBeats.join(", ")}.` : "No approvals to withdraw."} New stills for beat ${beatIndex} wait for your approval in Chat.`,
      });
      await refresh();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function loadVersions() {
    if (!script) return;
    try {
      setVersions((await getJson<{ versions: Script[] }>(`/api/scripts/${script.id}/versions`)).versions);
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  }

  if (!script && scripts.length === 0 && beats === STARTER && !busy) {
    return (
      <div className="space-y-4">
        <EmptyState title="No script yet">Ask the assistant to write one from the brief, or start from a single beat and edit it here.</EmptyState>
        <Button variant="outline" onClick={() => setBeats([...STARTER])}>
          <Plus /> Write a script by hand
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {scripts.length > 1 ? (
          <NativeSelect value={script?.id} onChange={(event) => setScriptId(event.target.value)} aria-label="Script">
            {scripts.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>{entry.title}</NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        <Input value={title} onChange={(event) => setTitle(event.target.value)} className="max-w-sm" aria-label="Script title" maxLength={120} />
        {script ? <span className="text-xs text-muted-foreground">Version {script.version}</span> : <span className="text-xs text-muted-foreground">Not saved</span>}
        <div className="ml-auto flex gap-2">
          {script ? (
            <Button size="sm" variant="ghost" onClick={() => void loadVersions()}>
              <History /> History
            </Button>
          ) : null}
          <Button size="sm" onClick={() => void save()} disabled={busy || !dirty || !title.trim()}>
            <Save /> Save {script ? "new version" : "script"}
          </Button>
          {script ? (
            <Button size="sm" variant="outline" onClick={() => void planShots()} disabled={busy || dirty || (content?.scriptVersion === script.version)}>
              {content ? (content.scriptVersion === script.version ? "Shots are current" : `Update shots to v${script.version}`) : "Plan shots"}
            </Button>
          ) : null}
        </div>
      </div>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {versions ? (
        <div className="rounded-lg border p-3 text-xs">
          <div className="mb-2 font-medium">Versions</div>
          <ul className="space-y-1">
            {versions.map((version) => (
              <li key={version.version} className="flex items-center gap-2">
                <span>v{version.version} · {version.beats.length} beats · {new Date(version.updatedAt).toLocaleString()}</span>
                {version.version !== script?.version ? (
                  <Button size="xs" variant="ghost" onClick={() => { setBeats(toDraft(version)); setTitle(version.title); }}>
                    Load into editor
                  </Button>
                ) : <span className="text-muted-foreground">current</span>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">Loading an older version and saving makes it the newest version.</p>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="p-2">#</th>
              <th className="p-2">Type and purpose</th>
              <th className="p-2">Spoken line</th>
              <th className="p-2">On-screen text</th>
              <th className="p-2">Visual and setting</th>
              <th className="p-2">Length</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {beats.map((beat, index) => (
              <tr key={index} className="border-t align-top">
                <td className="p-2 font-medium">{index + 1}</td>
                <td className="space-y-1 p-2">
                  <NativeSelect size="sm" value={beat.type} onChange={(event) => update(index, { type: event.target.value as DraftBeat["type"] })} aria-label={`Beat ${index + 1} type`}>
                    {BEAT_TYPES.map((type) => <NativeSelectOption key={type} value={type}>{type === "broll" ? "b-roll" : type === "textcard" ? "text card" : type}</NativeSelectOption>)}
                  </NativeSelect>
                  <NativeSelect size="sm" value={beat.purpose} onChange={(event) => update(index, { purpose: event.target.value as DraftBeat["purpose"] })} aria-label={`Beat ${index + 1} purpose`}>
                    {PURPOSES.map((purpose) => <NativeSelectOption key={purpose} value={purpose}>{purpose}</NativeSelectOption>)}
                  </NativeSelect>
                  <label className="flex items-center gap-1 text-muted-foreground">
                    <input type="checkbox" checked={beat.productVisible} onChange={(event) => update(index, { productVisible: event.target.checked })} /> product visible
                  </label>
                </td>
                <td className="p-2"><Textarea rows={3} value={beat.spokenLine} onChange={(event) => update(index, { spokenLine: event.target.value })} aria-label={`Beat ${index + 1} spoken line`} className="min-w-40 text-xs" /></td>
                <td className="p-2"><Textarea rows={3} value={beat.onScreenText} onChange={(event) => update(index, { onScreenText: event.target.value })} aria-label={`Beat ${index + 1} on-screen text`} className="min-w-32 text-xs" /></td>
                <td className="space-y-1 p-2">
                  <Textarea rows={3} value={beat.visual} onChange={(event) => update(index, { visual: event.target.value })} aria-label={`Beat ${index + 1} visual`} className="min-w-48 text-xs" />
                  <Input value={beat.setting} onChange={(event) => update(index, { setting: event.target.value })} placeholder="Setting" aria-label={`Beat ${index + 1} setting`} className="h-7 text-xs" />
                </td>
                <td className="p-2">
                  <Input type="number" min={1} max={15} step={0.5} value={beat.durationSeconds} onChange={(event) => update(index, { durationSeconds: Number(event.target.value) })} aria-label={`Beat ${index + 1} length in seconds`} className="h-7 w-16 text-xs" />
                </td>
                <td className="p-2">
                  <div className="flex flex-col gap-1">
                    <Button size="icon-xs" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move beat ${index + 1} up`}><ArrowUp /></Button>
                    <Button size="icon-xs" variant="ghost" disabled={index === beats.length - 1} onClick={() => move(index, 1)} aria-label={`Move beat ${index + 1} down`}><ArrowDown /></Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={busy || dirty || !content || content.scriptVersion !== script?.version}
                      onClick={() => void regenerateFrom(index + 1)}
                      aria-label={`Regenerate from beat ${index + 1}`}
                      title="Regenerate from here"
                    >
                      <RotateCcw />
                    </Button>
                    <Button size="icon-xs" variant="ghost" disabled={beats.length === 1} onClick={() => setBeats((current) => current.filter((_, position) => position !== index))} aria-label={`Remove beat ${index + 1}`}><Trash2 /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button size="sm" variant="outline" onClick={() => setBeats((current) => [...current, blankBeat()])} disabled={beats.length >= 8}>
        <Plus /> Add beat
      </Button>
      <p className="text-xs text-muted-foreground">
        Editing a beat&apos;s visual withdraws its approved still and clip; editing only the spoken line or length withdraws only the clip.
      </p>
    </div>
  );
}
