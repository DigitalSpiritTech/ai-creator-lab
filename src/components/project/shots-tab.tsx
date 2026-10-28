/**
 * Shots tab: one row per beat with its still and clip candidates, the approved still and clip,
 * status, and actions that ask for proposals (compose stills, make clip) through the gate.
 * @packageDocumentation
 */
"use client";

import { Clapperboard, ImagePlus, Mic } from "lucide-react";
import { useState } from "react";
import { CandidateGrid } from "@/components/cards/candidate-grid";
import { AssetMedia } from "@/components/media/asset-media";
import { pendingTiles, useProject } from "@/components/project/project-context";
import { EmptyState, Notice } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { callTool, errorMessage } from "@/lib/client/api";
import { assetKindInfo } from "@/lib/client/format";
import type { Asset, GenerationProposal } from "@/lib/client/types";
import type { Shot, Slot } from "@/lib/domain/content";

export function slotStatus(slot: Slot, noun: string): string {
  if (slot.state === "approved") return `${noun} approved`;
  if (slot.state === "open") return `${slot.candidateIds.length} ${noun} candidate${slot.candidateIds.length === 1 ? "" : "s"}`;
  return `No ${noun} yet`;
}

/** Whether a beat's line is read as a voice-over (b-roll and text cards with a line). */
export function hasVoiceOver(beat?: { type: string; spokenLine: string }): boolean {
  return !!beat && beat.type !== "talking" && beat.spokenLine.trim().length > 0;
}

export function shotStatus(shot: Shot, beat?: { type: string; spokenLine: string }): string {
  if (shot.clip.state === "approved") {
    if (hasVoiceOver(beat) && shot.voice.state !== "approved") return shot.voice.state === "open" ? "Choose a voice-over" : "Needs a voice-over";
    return "Ready";
  }
  if (shot.still.state === "approved") return shot.clip.state === "open" ? "Choose a clip" : "Needs a clip";
  return shot.still.state === "open" ? "Choose a still" : "Needs a still";
}

export function ShotsTab() {
  const { view } = useProject();
  const [contentId, setContentId] = useState<string | null>(view.contents[0]?.id ?? null);
  const content = view.contents.find((entry) => entry.id === contentId) ?? view.contents[0];
  if (!content) {
    return <EmptyState title="No shots planned">Save a script, then choose Plan shots on the Script tab (or ask the assistant).</EmptyState>;
  }
  const script = view.scripts.find((entry) => entry.id === content.scriptId);
  const assets = new Map(view.assets.map((asset) => [asset.id, asset]));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {view.contents.length > 1 ? (
          <NativeSelect value={content.id} onChange={(event) => setContentId(event.target.value)} aria-label="Content piece">
            {view.contents.map((entry) => <NativeSelectOption key={entry.id} value={entry.id}>{entry.title}</NativeSelectOption>)}
          </NativeSelect>
        ) : <h2 className="text-sm font-medium">{content.title}</h2>}
        <span className="text-xs text-muted-foreground">Script version {content.scriptVersion}</span>
      </div>
      {script && script.version !== content.scriptVersion ? (
        <Notice tone="warn">The script has a newer version ({script.version}). Update the shots from the Script tab.</Notice>
      ) : null}
      {content.shots.map((shot) => (
        <ShotRow key={shot.id} shot={shot} contentId={content.id} beat={script?.beats[shot.beatIndex - 1]} assets={assets} />
      ))}
    </div>
  );
}

function slotAssets(slot: Slot, assets: Map<string, Asset>): Asset[] {
  if (slot.state === "empty") return [];
  return slot.candidateIds.map((id) => assets.get(id)).filter((asset): asset is Asset => !!asset);
}

function ShotRow({
  shot,
  contentId,
  beat,
  assets,
}: {
  shot: Shot;
  contentId: string;
  beat?: { type: string; purpose: string; spokenLine: string; visual: string; onScreenText: string };
  assets: Map<string, Asset>;
}) {
  const { projectId, view, jobs, propose, notify } = useProject();
  const [busy, setBusy] = useState(false);
  const stills = slotAssets(shot.still, assets);
  const clips = slotAssets(shot.clip, assets);
  const title = (id: string) => view.recipes[id] ?? id;
  const voices = slotAssets(shot.voice, assets);
  const forSlot = (slot: "still" | "clip" | "voice") =>
    pendingTiles(jobs, (target) => target.kind === "shot" && target.contentId === contentId && target.beatIndex === shot.beatIndex && target.slot === slot, title);
  const stillPending = forSlot("still");
  const clipPending = forSlot("clip");
  const voicePending = forSlot("voice");
  const approvedStill = shot.still.state === "approved" ? shot.still.assetId : null;
  const approvedClip = shot.clip.state === "approved" ? shot.clip.assetId : null;
  const approvedVoice = shot.voice.state === "approved" ? shot.voice.assetId : null;
  const voiceOver = hasVoiceOver(beat);
  const hasVoiceSample = view.characters.some(({ item }) => !!item.bible.references.voiceAssetId);
  // A talking beat can take the cloned voice too; its clip is then lip-synced to the take.
  const talkingTake = beat?.type === "talking" && beat.spokenLine.trim().length > 0 && (hasVoiceSample || voices.length > 0 || voicePending.length > 0);
  const lipSync = beat?.type === "talking" && !!approvedVoice;

  async function ask(tool: "compose_still" | "generate_clip" | "generate_voice_over") {
    setBusy(true);
    try {
      const input =
        tool === "generate_voice_over"
          ? { projectId, contentId, beatIndex: shot.beatIndex }
          : tool === "generate_clip" && lipSync
            ? { contentId, beatIndex: shot.beatIndex, mode: "speech" }
            : { contentId, beatIndex: shot.beatIndex };
      propose(await callTool<GenerationProposal>(tool, input, projectId), "workspace");
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function approve(kind: "still" | "clip" | "voice", asset: Asset) {
    await callTool("approve", { kind, assetId: asset.id, contentId, beatIndex: shot.beatIndex }, projectId);
  }

  return (
    <div className="rounded-xl border p-3" data-testid="shot-row">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            Beat {shot.beatIndex}
            {beat ? <Badge variant="outline">{beat.type === "broll" ? "b-roll" : beat.type}</Badge> : null}
            {beat ? <Badge variant="secondary">{beat.purpose}</Badge> : null}
            <span className="text-xs font-normal text-muted-foreground">{shotStatus(shot, beat)}</span>
          </div>
          {beat ? (
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              {beat.spokenLine ? `${beat.type === "talking" ? "" : "Voice-over: "}“${beat.spokenLine}” · ` : ""}{beat.visual}
            </p>
          ) : null}
          {shot.brokenAssetIds.length ? <p className="mt-1 text-xs text-destructive">An approved file was deleted; choose again.</p> : null}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant={!approvedStill && !stills.length && !stillPending.length ? "default" : "outline"} disabled={busy} onClick={() => void ask("compose_still")}>
            <ImagePlus /> {stills.length || stillPending.length ? "More stills" : "Compose stills"}
          </Button>
          <Button
            size="sm"
            variant={approvedStill && !approvedClip && !clips.length && !clipPending.length ? "default" : "outline"}
            disabled={busy || !approvedStill}
            onClick={() => void ask("generate_clip")}
            title={approvedStill ? (lipSync ? "Lip-synced to the approved voice take (Wan 2.2 S2V, 4.8 s at most)" : undefined) : "Approve a still first"}
          >
            <Clapperboard /> {clips.length || clipPending.length ? "Another clip" : lipSync ? "Lip-sync clip" : "Make clip"}
          </Button>
          {voiceOver || talkingTake ? (
            <Button
              size="sm"
              variant={voiceOver && approvedClip && !approvedVoice && !voices.length && !voicePending.length ? "default" : "outline"}
              disabled={busy}
              onClick={() => void ask("generate_voice_over")}
              title={
                voiceOver
                  ? "Read the line in the creator's voice, cloned from the first approved talking clip or the character's voice recording"
                  : "Read this line in the cloned voice; the clip is then lip-synced to it, so every talking beat shares one voice"
              }
            >
              <Mic /> {voices.length || voicePending.length ? "Another take" : voiceOver ? "Voice-over" : "Voice take"}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-[160px_160px_1fr] gap-4">
        <ApprovedSlot label="Approved still" asset={approvedStill ? assets.get(approvedStill) : undefined} />
        <div className="space-y-2">
          <ApprovedSlot label="Approved clip" asset={approvedClip ? assets.get(approvedClip) : undefined} />
          {voiceOver || approvedVoice ? (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">{voiceOver ? "Approved voice-over" : "Approved voice take"}</div>
              {approvedVoice && assets.get(approvedVoice) ? (
                <AssetMedia asset={assets.get(approvedVoice)!} />
              ) : (
                <div className="rounded-lg border border-dashed p-2 text-xs text-muted-foreground">None</div>
              )}
            </div>
          ) : null}
        </div>
        <div className="min-w-0 space-y-3">
          {stills.length || stillPending.length ? (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">{slotStatus(shot.still, "still")}</div>
              <CandidateGrid assets={stills} pending={stillPending} approvedId={approvedStill} onApprove={(asset) => approve("still", asset)} className="lg:grid-cols-3" />
            </div>
          ) : null}
          {clips.length || clipPending.length ? (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">{slotStatus(shot.clip, "clip")}</div>
              <CandidateGrid assets={clips} pending={clipPending} approvedId={approvedClip} onApprove={(asset) => approve("clip", asset)} className="lg:grid-cols-3" />
            </div>
          ) : null}
          {voices.length || voicePending.length ? (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">{slotStatus(shot.voice, voiceOver ? "voice-over" : "voice take")}</div>
              <CandidateGrid assets={voices} pending={voicePending} approvedId={approvedVoice} onApprove={(asset) => approve("voice", asset)} compact className="lg:grid-cols-2" />
            </div>
          ) : null}
          {!stills.length && !clips.length && !voices.length && !stillPending.length && !clipPending.length && !voicePending.length ? <p className="text-xs text-muted-foreground">No candidates yet.</p> : null}
        </div>
      </div>
    </div>
  );
}

function ApprovedSlot({ label, asset }: { label: string; asset?: Asset }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      {asset ? (
        <AssetMedia asset={asset} controls={assetKindInfo(asset.kind).playable} className="aspect-[9/16] w-full rounded-lg" />
      ) : (
        <div className="flex aspect-[9/16] w-full items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">None</div>
      )}
    </div>
  );
}
