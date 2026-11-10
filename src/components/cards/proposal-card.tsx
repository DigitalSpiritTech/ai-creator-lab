/**
 * The spending gate as a card: recipe, candidate count, estimated cost, prompt, and Approve and
 * generate or Cancel. With auto-approve on, it submits once on mount and says so. When approving
 * would cross this month's remaining budget, nothing runs and the extend dialog opens.
 * @packageDocumentation
 */
"use client";

import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Notice } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BudgetDialog } from "@/components/cards/budget-dialog";
import { errorMessage, submitProposal } from "@/lib/client/api";
import { CAPABILITY_LABELS, budgetBlock, describeBudgetBlock, describeEstimate, describeSpendWarning, describeTarget, summarizeSubmit } from "@/lib/client/format";
import type { GenerationProposal, SubmitResult } from "@/lib/client/types";
import type { BudgetCrossing, SpendWarning } from "@/lib/domain/spend";

type GateState =
  | { state: "pending" }
  | { state: "submitting" }
  | { state: "submitted"; results: SubmitResult[] }
  | { state: "needs_confirmation"; message: string }
  /** Approving would cross this month's remaining budget; the extend dialog is open. */
  | { state: "over_budget"; crossing: BudgetCrossing; confirmUnquoted: boolean; ran: number }
  | { state: "cancelled"; ran?: number }
  | { state: "error"; message: string };

export interface ProposalCardProps {
  proposal: GenerationProposal;
  autoApprove?: boolean;
  /** Called after the gate accepted the proposal, so the page can start polling. */
  onSubmitted?: (results: SubmitResult[]) => void;
  /** Initial state, for rendering a decided card again. */
  initial?: GateState;
}

export function ProposalCard({ proposal, autoApprove = false, onSubmitted, initial }: ProposalCardProps) {
  const rejected = proposal.estimate.kind === "rejected";
  const [gate, setGate] = useState<GateState>(initial ?? (autoApprove && !rejected ? { state: "submitting" } : { state: "pending" }));
  const [warning, setWarning] = useState<SpendWarning>(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const started = useRef(false);

  function submit(confirmUnquoted = false) {
    setGate({ state: "submitting" });
    void send(confirmUnquoted);
  }

  async function send(confirmUnquoted = false) {
    try {
      const { results, warning: level } = await submitProposal(proposal, confirmUnquoted);
      const block = budgetBlock(results);
      if (block) {
        // The rest of the proposal would cross this month's budget: ask before spending more. This
        // also covers a resubmission after an extension that still falls short, which reopens the
        // dialog with the new figures rather than showing an error.
        setGate({ state: "over_budget", crossing: block.crossing, confirmUnquoted, ran: block.ran });
        setDialogOpen(true);
        if (block.ran > 0) onSubmitted?.(results.filter((result) => result.job !== null));
        return;
      }
      const confirm = results.find((result) => result.outcome === "needs_confirmation");
      if (confirm) {
        setGate({ state: "needs_confirmation", message: confirm.message ?? "This recipe has no live price." });
        return;
      }
      setWarning(level);
      setGate({ state: "submitted", results });
      onSubmitted?.(results);
    } catch (cause) {
      setGate({ state: "error", message: errorMessage(cause) });
    }
  }

  useEffect(() => {
    if (!autoApprove || initial || rejected || started.current) return;
    started.current = true;
    // Auto-approve is the user's own setting; the server still enforces the budget.
    void send();
    // Submit once per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = gate.state === "submitted" ? summarizeSubmit(gate.results) : null;
  const budgetNotice = gate.state === "submitted" ? describeSpendWarning(warning, null) : null;

  return (
    <div className="rounded-xl border bg-card p-3 text-sm shadow-xs" data-testid="proposal-card">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <Sparkles className="size-4 text-primary" aria-hidden />
          {describeTarget(proposal.target)}
        </div>
        <Badge variant="secondary">{CAPABILITY_LABELS[proposal.capability]}</Badge>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Recipe</dt>
        <dd>{proposal.recipeTitle}</dd>
        <dt className="text-muted-foreground">Candidates</dt>
        <dd>{proposal.count}</dd>
        <dt className="text-muted-foreground">Estimated cost</dt>
        <dd>{describeEstimate(proposal.estimate, proposal.count)}</dd>
        {proposal.references.length ? (
          <>
            <dt className="text-muted-foreground">References</dt>
            <dd>{proposal.references.length} image{proposal.references.length === 1 ? "" : "s"}</dd>
          </>
        ) : null}
      </dl>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Prompt</summary>
        <p className="mt-1 whitespace-pre-wrap">{proposal.prompt}</p>
      </details>
      {proposal.estimate.note ? <p className="mt-2 text-xs text-muted-foreground">{proposal.estimate.note}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {gate.state === "pending" ? (
          <>
            <Button size="sm" onClick={() => submit()} disabled={rejected}>
              <Check /> Approve and generate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setGate({ state: "cancelled" })}>
              <X /> Cancel
            </Button>
          </>
        ) : null}
        {gate.state === "submitting" ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {autoApprove ? "Auto-approved under your budget. Submitting…" : "Submitting…"}
          </span>
        ) : null}
        {gate.state === "needs_confirmation" ? (
          <div className="flex w-full flex-col gap-2">
            <Notice tone="warn">{gate.message}</Notice>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => submit(true)}>Reserve and generate</Button>
              <Button size="sm" variant="ghost" onClick={() => setGate({ state: "cancelled" })}>Cancel</Button>
            </div>
          </div>
        ) : null}
        {gate.state === "cancelled" ? <span className="text-xs text-muted-foreground">{gate.ran ? `Cancelled. ${gate.ran} candidate${gate.ran === 1 ? " had" : "s had"} already run; the rest were not started.` : "Cancelled. Nothing was generated."}</span> : null}
        {gate.state === "error" ? (
          <div className="flex w-full flex-col gap-2">
            <Notice>{gate.message}</Notice>
            <Button size="sm" variant="outline" className="w-fit" onClick={() => submit()}>Try again</Button>
          </div>
        ) : null}
        {gate.state === "over_budget" ? (
          <div className="flex w-full flex-col gap-2">
            <Notice tone="warn">{describeBudgetBlock(gate.ran)}</Notice>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>Review the budget</Button>
              <Button size="sm" variant="ghost" onClick={() => setGate({ state: "cancelled", ran: gate.ran })}>Cancel</Button>
            </div>
          </div>
        ) : null}
        {summary ? (
          <div className="w-full">
            <Notice tone={summary.tone}>{autoApprove ? `Auto-approved under your budget. ${summary.text}` : summary.text}</Notice>
          </div>
        ) : null}
        {budgetNotice ? (
          <div className="w-full">
            <Notice tone={budgetNotice.tone}>{budgetNotice.text}</Notice>
          </div>
        ) : null}
      </div>
      <BudgetDialog
        crossing={gate.state === "over_budget" && dialogOpen ? gate.crossing : null}
        onCancel={() => setDialogOpen(false)}
        onExtended={() => {
          setDialogOpen(false);
          submit(gate.state === "over_budget" && gate.confirmUnquoted);
        }}
      />
    </div>
  );
}
