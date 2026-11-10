/**
 * Quick Ad tab (v0.2 F11): two lines start a Quick Ad (`start_quick_ad`), then the three
 * approvals as one column: the frame (`compose_still`, one candidate), the talking clip
 * (`generate_clip`), and the export (`assemble_ad`). Each generation is a proposal that goes to the
 * gate in the chat panel; nothing here spends on its own.
 * @packageDocumentation
 */
"use client";

import { Check, Download, Film, ImageIcon, Loader2, Video, Zap } from "lucide-react";
import { useState } from "react";
import { QUICK_AD, defaultOnScreenText, defaultSpokenLine, quickAdProgress } from "@creator-lab/core/domain/quick-ad";
import { CandidateGrid } from "@/components/cards/candidate-grid";
import { AssetMedia } from "@/components/media/asset-media";
import { pendingTiles, useProject } from "@/components/project/project-context";
import { Notice } from "@/components/shell/page-header";
import { Badge } from "@creator-lab/ui/badge";
import { Button } from "@creator-lab/ui/button";
import { Input } from "@creator-lab/ui/input";
import { assetUrl, callTool, errorMessage } from "@/lib/client/api";
import type { Asset, ExportRecord, GenerationProposal } from "@/lib/client/types";

export function QuickAdTab() {
  const { view } = useProject();
  // Contents come newest first; the tab works on the newest Quick Ad.
  const content = view.contents.find((entry) => entry.mode === "quick");
  const [starting, setStarting] = useState(false);
  if (!content || starting) return <QuickAdStart onStarted={() => setStarting(false)} again={!!content} />;
  return <QuickAdSteps contentId={content.id} onAnother={() => setStarting(true)} />;
}

function QuickAdStart({ onStarted, again }: { onStarted(): void; again: boolean }) {
  const { projectId, view, refresh, notify } = useProject();
  const [productSummary, setProductSummary] = useState(view.project.brief?.productSummary ?? "");
  const [audience, setAudience] = useState(view.project.brief?.audience ?? "");
  const [spokenLine, setSpokenLine] = useState<string | null>(null);
  const [onScreenText, setOnScreenText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const character = view.characters.find(({ item, link }) => link.sheetAssetId || item.bible.references.faceAssetId);
  const product = view.products[0];
  const line = spokenLine ?? (productSummary.trim() ? defaultSpokenLine(productSummary) : "");
  const caption = onScreenText ?? (productSummary.trim() ? defaultOnScreenText(productSummary) : "");

  async function start() {
    setBusy(true);
    try {
      await callTool("start_quick_ad", { projectId, brief: { productSummary, audience }, ...(line.trim() ? { spokenLine: line } : {}), onScreenText: caption }, projectId);
      await refresh();
      onStarted();
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="max-w-xl space-y-4"
      aria-label="Start a Quick Ad"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <div>
        <h2 className="text-sm font-semibold">{again ? "Another Quick Ad" : "Quick Ad"}</h2>
        <p className="text-xs text-muted-foreground">
          Two lines, then three approvals: one frame, one {QUICK_AD.durationSeconds}-second talking clip, and the export. Every generation shows its cost on a card in the chat first.
        </p>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">What you&apos;re selling</span>
        <Input value={productSummary} onChange={(event) => setProductSummary(event.target.value)} maxLength={300} placeholder="Ridgeline 32 oz insulated bottle, keeps drinks cold 24 hours" required />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Who it&apos;s for</span>
        <Input value={audience} onChange={(event) => setAudience(event.target.value)} maxLength={300} placeholder="Commuters who leave a drink in the car, on TikTok" required />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">What the creator says</span>
        <Input value={line} onChange={(event) => setSpokenLine(event.target.value)} maxLength={300} placeholder="About ten words" />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">On-screen text</span>
        <Input value={caption} onChange={(event) => setOnScreenText(event.target.value)} maxLength={80} placeholder="Six words at most; empty for none" />
      </label>
      <p className="text-xs text-muted-foreground">
        {character ? `The frame uses ${character.item.bible.name}'s ${character.link.sheetAssetId ? "reference sheet" : "locked face"}` : "No Library character is linked, so the frame is made from these lines"}
        {product ? ` and ${product.name}${product.imageAssetIds.length ? " with its photo" : ""}.` : "."} Link a character and a product with a photo in the Documents tab for a frame composed from them.
      </p>
      <Button type="submit" disabled={busy || !productSummary.trim() || !audience.trim()}>
        {busy ? <Loader2 className="animate-spin" /> : <Zap />} Start the Quick Ad
      </Button>
    </form>
  );
}

type QuickStep = "frame" | "clip" | "export";

function QuickAdStep({ n, label, done, next, children }: { n: number; label: string; done: boolean; next: boolean; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border p-3" aria-label={label}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-5 items-center justify-center rounded-full border text-xs">{done ? <Check className="size-3" /> : n}</span>
        {label}
        {done ? <Badge variant="secondary">Approved</Badge> : next ? <Badge>Next</Badge> : null}
      </div>
      {children}
    </section>
  );
}

function slotAssets(ids: string[], assets: Map<string, Asset>): Asset[] {
  return ids.map((id) => assets.get(id)).filter((asset): asset is Asset => !!asset);
}

function QuickAdSteps({ contentId, onAnother }: { contentId: string; onAnother(): void }) {
  const { projectId, view, refresh, propose, notify, jobs } = useProject();
  const [busy, setBusy] = useState(false);
  const content = view.contents.find((entry) => entry.id === contentId)!;
  const shot = content.shots[0];
  const script = view.scripts.find((entry) => entry.id === content.scriptId);
  const beat = script?.beats[0];
  const exports = view.exports.filter((record) => record.contentId === content.id);
  const finished = exports.find((record): record is Extract<ExportRecord, { status: "completed" }> => record.status === "completed");
  const progress = quickAdProgress(content, exports.filter((record) => record.status === "completed").length);
  const assets = new Map(view.assets.map((asset) => [asset.id, asset]));
  const title = (id: string) => view.recipes[id] ?? id;
  const pending = (slot: "still" | "clip") =>
    pendingTiles(jobs, (target) => target.kind === "shot" && target.contentId === content.id && target.beatIndex === shot.beatIndex && target.slot === slot, title);
  const stillIds = shot.still.state === "empty" ? [] : shot.still.candidateIds;
  const clipIds = shot.clip.state === "empty" ? [] : shot.clip.candidateIds;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const ask = (tool: "compose_still" | "generate_clip") =>
    run(async () => {
      const input = tool === "compose_still" ? { contentId, beatIndex: shot.beatIndex, count: QUICK_AD.frameCount } : { contentId, beatIndex: shot.beatIndex };
      propose(await callTool<GenerationProposal>(tool, input, projectId), "workspace");
    });

  const approve = (kind: "still" | "clip") => async (asset: Asset) => {
    await callTool("approve", { kind, assetId: asset.id, contentId, beatIndex: shot.beatIndex }, projectId);
    await refresh();
  };

  const exportAd = () =>
    run(async () => {
      const { export: record } = await callTool<{ export: ExportRecord }>("assemble_ad", { contentId, captions: true }, projectId);
      if (record.status === "failed") notify("error", record.error);
      await refresh();
    });

  const done = (step: QuickStep) => progress.approved.includes(step);

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{content.title}</h2>
          {beat ? (
            <p className="text-xs text-muted-foreground">
              Says &ldquo;{beat.spokenLine}&rdquo;{beat.onScreenText ? ` · on screen "${beat.onScreenText}"` : ""} · {beat.durationSeconds} s
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{progress.approved.length} of {QUICK_AD.approvals.length} approvals given.</p>
        </div>
        <Button size="sm" variant="outline" onClick={onAnother}>Another Quick Ad</Button>
      </div>
      {script && script.version !== content.scriptVersion ? <Notice tone="warn">The script has a newer version. Update the shots from the Script tab.</Notice> : null}

      <QuickAdStep n={1} label="Frame" done={done("frame")} next={progress.next === "frame"}>
        {!done("frame") ? (
          <Button size="sm" variant={progress.next === "frame" && stillIds.length === 0 ? "default" : "outline"} disabled={busy} onClick={() => void ask("compose_still")}>
            <ImageIcon /> {stillIds.length ? "Compose another frame" : "Compose the frame"}
          </Button>
        ) : null}
        <CandidateGrid assets={slotAssets(stillIds, assets)} pending={pending("still")} approvedId={shot.still.state === "approved" ? shot.still.assetId : null} onApprove={approve("still")} className="lg:grid-cols-3" />
      </QuickAdStep>

      <QuickAdStep n={2} label="Talking clip" done={done("clip")} next={progress.next === "clip"}>
        {done("frame") && !done("clip") ? (
          <Button size="sm" variant={clipIds.length === 0 ? "default" : "outline"} disabled={busy} onClick={() => void ask("generate_clip")}>
            <Video /> {clipIds.length ? "Make another clip" : "Make the clip"}
          </Button>
        ) : !done("frame") ? (
          <p className="text-xs text-muted-foreground">Approve the frame first; the clip starts from it.</p>
        ) : null}
        <CandidateGrid assets={slotAssets(clipIds, assets)} pending={pending("clip")} approvedId={shot.clip.state === "approved" ? shot.clip.assetId : null} onApprove={approve("clip")} className="lg:grid-cols-3" />
      </QuickAdStep>

      <QuickAdStep n={3} label="Export" done={done("export")} next={progress.next === "export"}>
        <Button size="sm" variant={progress.next === "export" ? "default" : "outline"} disabled={busy || !done("clip")} onClick={() => void exportAd()} title={done("clip") ? undefined : "Approve the clip first"}>
          {busy ? <Loader2 className="animate-spin" /> : <Film />} {finished ? "Export again" : "Export 1080 x 1920"}
        </Button>
        {finished ? (
          <div className="space-y-2">
            <AssetMedia asset={assets.get(finished.assetId) ?? { id: finished.assetId, kind: "export", mime: "video/mp4", video: undefined }} controls className="aspect-[9/16] w-56 rounded-lg" />
            <Button asChild size="sm" variant="outline">
              <a href={assetUrl(finished.assetId, { download: true })}><Download /> Download</a>
            </Button>
          </div>
        ) : null}
      </QuickAdStep>
    </div>
  );
}
