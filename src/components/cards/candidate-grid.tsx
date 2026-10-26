/**
 * Candidate grid: thumbnails with Select, Approve, Archive, and Refine. Approve is supplied by the
 * caller (lock a face or body, approve a sheet, a still, or a clip); Refine asks `refine_still` for
 * a proposal that lands in the chat panel's gate.
 * @packageDocumentation
 */
"use client";

import { Archive, Check, Maximize2, Wand2 } from "lucide-react";
import { useState } from "react";
import { AssetMedia } from "@/components/media/asset-media";
import { useProject } from "@/components/project/project-context";
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
  className?: string;
}

export function CandidateGrid({ assets, approvedId, approveLabel = "Approve", onApprove, inspection, className }: CandidateGridProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Asset | null>(null);
  if (assets.length === 0) return null;
  return (
    <>
      <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>
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

function CandidateCard({
  asset,
  approved,
  selected,
  onSelect,
  onView,
  approveLabel,
  onApprove,
}: {
  asset: Asset;
  approved: boolean;
  selected: boolean;
  onSelect: () => void;
  onView: () => void;
  approveLabel: string;
  onApprove?: (asset: Asset) => Promise<void>;
}) {
  const { refresh, propose, notify } = useProject();
  const [busy, setBusy] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [instruction, setInstruction] = useState("");
  const recipe = asset.provenance.source === "generated" ? asset.provenance.recipeId : asset.provenance.source;
  const still = asset.kind === "image" || asset.kind === "sheet";

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
      <button type="button" onClick={onView} className="group relative aspect-[9/16] max-h-64 w-full bg-muted" aria-label="View full size">
        <AssetMedia asset={asset} className="size-full" />
        <Maximize2 className="absolute top-2 right-2 size-4 text-white opacity-0 drop-shadow group-hover:opacity-100" aria-hidden />
      </button>
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
      </div>
    </div>
  );
}
