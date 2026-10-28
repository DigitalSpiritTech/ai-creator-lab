/**
 * Candidate grid: thumbnails with Select, Approve, Archive, and Refine. Approve is supplied by the
 * caller (lock a face or body, approve a sheet, a still, or a clip); Refine asks `refine_still` for
 * a proposal that lands in the chat panel's gate.
 * @packageDocumentation
 */
"use client";

import { AlertTriangle, Archive, Check, Loader2, Maximize2, Wand2 } from "lucide-react";
import { useState } from "react";
import { AssetMedia } from "@/components/media/asset-media";
import { type PendingTile, useProject } from "@/components/project/project-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { callTool, errorMessage } from "@/lib/client/api";
import type { Asset, GenerationProposal } from "@/lib/client/types";
import { cn } from "@/lib/utils";

export interface CandidateGridProps {
  assets: Asset[];
  approvedId?: string | null;
  approveLabel?: string;
  onApprove?: (asset: Asset) => Promise<void>;
  /** Shown under the full-size view, for example the reference sheet checklist. */
  inspection?: React.ReactNode;
  /** Jobs still running (or just failed) for this grid: one placeholder tile each, where the result will land. */
  pending?: PendingTile[];
  /** Extra controls under a card, for example "Use as" on a loose asset. */
  extra?: (asset: Asset) => React.ReactNode;
  /** Short placeholder tiles, for audio takes rather than 9:16 images. */
  compact?: boolean;
  className?: string;
}

export function CandidateGrid({ assets, approvedId, approveLabel = "Approve", onApprove, inspection, pending = [], extra, compact = false, className }: CandidateGridProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Asset | null>(null);
  if (assets.length === 0 && pending.length === 0) return null;
  return (
    <>
      <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>
        {pending.map((tile) => <PendingCard key={tile.id} tile={tile} compact={compact} />)}
        {assets.map((asset) => (
          <CandidateCard
            key={asset.id}
            asset={asset}
            approved={asset.id === approvedId}
            selected={asset.id === selected}
            onSelect={() => setSelected((current) => (current === asset.id ? null : asset.id))}
            onView={() => setViewing(asset)}
            approveLabel={approveLabel}
            onApprove={onApprove}
            extra={extra?.(asset)}
          />
        ))}
      </div>
      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Full size</DialogTitle>
            <DialogDescription>Inspect the candidate before approving it.</DialogDescription>
          </DialogHeader>
          {viewing ? <AssetMedia asset={viewing} controls className="max-h-[70vh] w-full rounded-lg" /> : null}
          {inspection}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Where a candidate will appear: a spinner and the recipe while the job runs, the error when it failed. */
function PendingCard({ tile, compact = false }: { tile: PendingTile; compact?: boolean }) {
  return (
    <div
      className={cn("flex flex-col overflow-hidden rounded-xl border bg-card text-xs", tile.failed ? "border-destructive/50" : "border-dashed")}
      data-testid="pending-card"
      role="status"
      aria-live="polite"
    >
      <div className={cn("flex w-full flex-col items-center justify-center gap-2 bg-muted/60 p-3 text-center", compact ? "min-h-24" : "aspect-[9/16] max-h-64")}>
        {tile.failed ? <AlertTriangle className="size-5 text-destructive" aria-hidden /> : <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />}
        <span className={cn("font-medium", tile.failed && "text-destructive")}>{tile.failed ? "Failed" : tile.status}</span>
        <span className="line-clamp-4 text-muted-foreground">{tile.failed ?? "The result lands here."}</span>
      </div>
      <div className="p-2">
        <span className="truncate text-muted-foreground" title={tile.label}>{tile.label}</span>
      </div>
    </div>
  );
}

function CandidateCard({
  asset,
  approved,
  selected,
  onSelect,
  onView,
  approveLabel,
  onApprove,
  extra,
}: {
  asset: Asset;
  approved: boolean;
  selected: boolean;
  onSelect: () => void;
  onView: () => void;
  approveLabel: string;
  onApprove?: (asset: Asset) => Promise<void>;
  extra?: React.ReactNode;
}) {
  const { refresh, propose, notify } = useProject();
  const [busy, setBusy] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [instruction, setInstruction] = useState("");
  const recipe = asset.provenance.source === "generated" ? asset.provenance.recipeId : asset.provenance.source;
  const still = asset.kind === "image" || asset.kind === "sheet";
  const audio = asset.kind === "audio";

  async function act(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
      await refresh();
    } catch (cause) {
      notify("error", errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-card text-xs",
        selected && "ring-2 ring-primary",
        approved && "border-emerald-500 ring-2 ring-emerald-500/40",
      )}
      data-testid="candidate-card"
    >
      {audio ? (
        <div className="p-2 pb-0">
          <AssetMedia asset={asset} />
        </div>
      ) : (
        <button type="button" onClick={onView} className="group relative aspect-[9/16] max-h-64 w-full bg-muted" aria-label="View full size">
          <AssetMedia asset={asset} className="size-full" />
          <Maximize2 className="absolute top-2 right-2 size-4 text-white opacity-0 drop-shadow group-hover:opacity-100" aria-hidden />
        </button>
      )}
      <div className="flex flex-col gap-2 p-2">
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-muted-foreground" title={recipe}>{recipe}</span>
          {approved ? <Badge className="bg-emerald-600 text-white">Approved</Badge> : null}
          {asset.provenance.source === "generated" && asset.provenance.mock ? <Badge variant="outline">Mock</Badge> : null}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant={selected ? "secondary" : "outline"} onClick={onSelect} aria-pressed={selected}>
            {selected ? "Selected" : "Select"}
          </Button>
          {onApprove && !approved ? (
            <Button size="xs" disabled={busy !== null} onClick={() => void act("approve", () => onApprove(asset))}>
              <Check /> {approveLabel}
            </Button>
          ) : null}
          {!approved ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void act("archive", async () => void (await callTool("archive_asset", { assetId: asset.id }, asset.projectId ?? undefined)))}
            >
              <Archive /> Archive
            </Button>
          ) : null}
          {still && asset.projectId ? (
            <Button size="xs" variant="ghost" onClick={() => setRefining((open) => !open)} aria-expanded={refining}>
              <Wand2 /> Refine
            </Button>
          ) : null}
        </div>
        {refining ? (
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!instruction.trim()) return;
              void act("refine", async () => {
                const proposal = await callTool<GenerationProposal>("refine_still", { assetId: asset.id, instruction: instruction.trim() }, asset.projectId ?? undefined);
                propose(proposal, "workspace");
                setInstruction("");
                setRefining(false);
              });
            }}
          >
            <Input value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Warmer light, bottle label facing camera" className="h-7 text-xs" aria-label="Refine instruction" />
            <Button size="xs" type="submit" disabled={busy !== null || !instruction.trim()}>Propose</Button>
          </form>
        ) : null}
        {extra}
      </div>
    </div>
  );
}
