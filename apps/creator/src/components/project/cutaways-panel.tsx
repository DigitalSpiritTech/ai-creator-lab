/**
 * The take-then-cutaways steps in the Export tab: make the full talking take (`generate_take`),
 * approve one (`approve` kind take), transcribe it (`transcribe_take`), and draft the edit decision
 * list (`save_edl`). The list itself is edited in the Documents tab; exporting uses `assemble_ad`
 * with strategy take_cutaways. Spending steps land in the chat panel's gate like every proposal.
 * @packageDocumentation
 */
"use client";

import { AudioLines, Clapperboard, ListVideo } from "lucide-react";
import { useState } from "react";
import { CandidateGrid } from "@/components/cards/candidate-grid";
import { pendingTiles, useProject } from "@/components/project/project-context";
import { Notice } from "@/components/shell/page-header";
import { Button } from "@creator-lab/ui/button";
import { callTool, errorMessage } from "@/lib/client/api";
import type { Asset, GenerationProposal } from "@/lib/client/types";
import type { ContentPiece } from "@creator-lab/core/domain/content";

/** Whether the Ad can be exported take-then-cutaways: an approved take and an EDL drafted for it. */
export function cutawaysReady(content: ContentPiece): boolean {
  return content.take.state === "approved" && content.edl !== null && content.edl.take.assetId === content.take.assetId && content.edl.scriptVersion >= content.scriptVersion;
}

export function CutawaysPanel({ content }: { content: ContentPiece }) {
  const { projectId, view, refresh, propose, notify, jobs } = useProject();
  const [busy, setBusy] = useState(false);
  const assets = new Map(view.assets.map((asset) => [asset.id, asset]));
  const takes = content.take.state === "empty" ? [] : content.take.candidateIds.map((id) => assets.get(id)).filter((asset): asset is Asset => !!asset);
  const approved = content.take.state === "approved" ? content.take.assetId : null;
  const title = (id: string) => view.recipes[id] ?? id;
  const takePending = pendingTiles(jobs, (target) => target.kind === "take" && target.contentId === content.id && target.slot === "clip", title);
  const transcribing = pendingTiles(jobs, (target) => target.kind === "take" && target.contentId === content.id && target.slot === "transcript", title);
  const approvedTake = approved ? assets.get(approved) : undefined;
  const transcribed =
    !!approvedTake &&
    view.assets.some(
      (asset) =>
        asset.kind === "transcript" &&
        asset.state.state === "active" &&
        asset.provenance.source === "generated" &&
        asset.provenance.inputs.some((input) => input.assetId === approvedTake.id && input.sha256 === approvedTake.sha256),
    );
  const edl = content.edl;
  const stale = !!edl && edl.take.assetId !== approved;

  async function ask(tool: "generate_take" | "transcribe_take") {
    setBusy(true);
    try {
      propose(await callTool<GenerationProposal>(tool, { contentId: content.id }, projectId), "workspace");
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function draft() {
    setBusy(true);
    try {
      const saved = await callTool<{ version: number | null; unplaced: number[]; estimated: number[] }>("save_edl", { contentId: content.id, draft: true }, projectId);
      notify(
        saved.unplaced.length || saved.estimated.length ? "warn" : "ok",
        `${saved.version ? `Edit decision list saved as version ${saved.version}` : "The edit decision list is already this draft"}.${saved.unplaced.length ? ` Beat${saved.unplaced.length === 1 ? "" : "s"} ${saved.unplaced.join(", ")} got no window: no line, or a line the recording never says.` : ""}${saved.estimated.length ? ` ${saved.estimated.length} beat${saved.estimated.length === 1 ? " was" : "s were"} placed by estimate (no word heard): beat${saved.estimated.length === 1 ? "" : "s"} ${saved.estimated.join(", ")}.` : ""} Edit it in the Documents tab.`,
      );
      await refresh();
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border p-3 text-sm" aria-label="Recording with cutaways">
      <p className="text-xs text-muted-foreground">
        The creator says the whole script in one continuous talking recording. B-roll replaces the picture in the edit decision list&apos;s windows, the recording&apos;s sound is kept as it is, and captions follow the words&apos; times.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={!takes.length && !takePending.length ? "default" : "outline"} disabled={busy} onClick={() => void ask("generate_take")}>
          <Clapperboard /> {takes.length || takePending.length ? "Another recording" : "Make the talking recording"}
        </Button>
        <Button size="sm" variant={approved && !transcribed && !transcribing.length ? "default" : "outline"} disabled={busy || !approved} onClick={() => void ask("transcribe_take")} title={approved ? undefined : "Approve a recording first"}>
          <AudioLines /> Transcribe the recording
        </Button>
        <Button size="sm" variant={transcribed && (!edl || stale) ? "default" : "outline"} disabled={busy || !transcribed} onClick={() => void draft()} title={transcribed ? undefined : "Transcribe the approved recording first"}>
          <ListVideo /> {edl && !stale ? "Draft the list again" : "Draft the edit decision list"}
        </Button>
      </div>
      {takes.length || takePending.length ? (
        <CandidateGrid
          assets={takes}
          pending={takePending}
          approvedId={approved}
          onApprove={async (asset) => {
            await callTool("approve", { kind: "take", contentId: content.id, assetId: asset.id }, projectId);
            await refresh();
          }}
          className="lg:grid-cols-3"
        />
      ) : null}
      {transcribing.length ? <Notice tone="muted">Transcribing the recording…</Notice> : null}
      {stale ? <Notice tone="warn">The edit decision list was drafted for another recording. Transcribe the approved recording and draft it again.</Notice> : null}
      {edl && !stale ? (
        <ul className="space-y-0.5 text-xs" aria-label="Cutaway windows">
          {edl.windows.length ? (
            edl.windows.map((window) => (
              <li key={window.beatIndex}>
                Beat {window.beatIndex}: {window.start.toFixed(2)} to {window.end.toFixed(2)} s
              </li>
            ))
          ) : (
            <li className="text-muted-foreground">No windows: the recording plays through.</li>
          )}
        </ul>
      ) : null}
    </section>
  );
}
