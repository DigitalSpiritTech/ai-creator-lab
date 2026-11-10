/**
 * The extend dialog on the approve step: shown when approving a proposal would cross this month's
 * remaining budget. It shows what was spent, what remains, and this action's cost, in USD with
 * credits beside them, and "add to this month", which raises only the current period up to the
 * operator ceiling. Only a person's click here (or in Settings) extends the budget.
 * @packageDocumentation
 */
"use client";

import { useState } from "react";
import { Notice } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorMessage, extendBudget } from "@/lib/client/api";
import { formatPeriodDate, formatUsd, formatUsdCredits, suggestedExtensionUsd } from "@/lib/client/format";
import type { BudgetCrossing } from "@/lib/domain/spend";

export interface BudgetDialogProps {
  crossing: BudgetCrossing | null;
  onCancel: () => void;
  /** Called once the extension is saved; the card then submits the proposal again. */
  onExtended: () => void;
}

export function BudgetDialog({ crossing, onCancel, onExtended }: BudgetDialogProps) {
  return (
    <Dialog open={crossing !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="budget-dialog">
        {crossing ? <BudgetDialogBody key={`${crossing.periodKey}:${crossing.costUsd}:${crossing.remainingUsd}`} crossing={crossing} onCancel={onCancel} onExtended={onExtended} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function BudgetDialogBody({ crossing, onCancel, onExtended }: { crossing: BudgetCrossing; onCancel: () => void; onExtended: () => void }) {
  const [amount, setAmount] = useState(() => String(suggestedExtensionUsd(crossing)));
  // One id per dialog, so a double click adds the money once.
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0 && value <= crossing.maxExtensionUsd + 1e-9;
  const enough = valid && value + 1e-9 >= crossing.neededUsd;

  async function extend(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await extendBudget({ id: requestId, periodKey: crossing.periodKey, amountUsd: value });
      onExtended();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void extend(event)} className="space-y-4">
      <DialogHeader>
        <DialogTitle>This would go over this month&apos;s budget</DialogTitle>
        <DialogDescription>
          The budget resets on {formatPeriodDate(crossing.periodEndsAt)}. Adding money here raises this month only; next month starts from your monthly budget again.
        </DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Spent this month</dt>
        <dd>{formatUsdCredits(crossing.spentUsd)}</dd>
        {crossing.reservedUsd > 0 ? (
          <>
            <dt className="text-muted-foreground">Reserved by runs in progress</dt>
            <dd>{formatUsdCredits(crossing.reservedUsd)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Remaining</dt>
        <dd>{formatUsdCredits(crossing.remainingUsd)}</dd>
        <dt className="text-muted-foreground">This action</dt>
        <dd className="font-medium">{formatUsdCredits(crossing.costUsd)}</dd>
        <dt className="text-muted-foreground">This month&apos;s budget</dt>
        <dd>
          {formatUsd(crossing.effectiveLimitUsd)}
          {crossing.extensionUsd > 0 ? ` (${formatUsd(crossing.limitUsd)} plus ${formatUsd(crossing.extensionUsd)} added)` : ""}
        </dd>
        <dt className="text-muted-foreground">Operator ceiling</dt>
        <dd>{formatUsd(crossing.ceilingUsd)} a month</dd>
      </dl>
      {crossing.extendable ? (
        <div className="space-y-1">
          <label htmlFor="budget-extension" className="text-sm font-medium">Add to this month (USD)</label>
          <Input
            id="budget-extension"
            type="number"
            min={0.01}
            max={crossing.maxExtensionUsd}
            step={0.01}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="w-32"
          />
          <p className="text-xs text-muted-foreground">
            At least {formatUsd(crossing.neededUsd)} to run this; at most {formatUsd(crossing.maxExtensionUsd)} under the operator ceiling.
            {valid ? ` ${formatUsdCredits(value)}.` : ""}
          </p>
          {valid && !enough ? <p className="text-xs text-amber-600">That is less than this action needs, so it will still be blocked.</p> : null}
        </div>
      ) : (
        <Notice tone="warn">
          The operator ceiling ({formatUsd(crossing.ceilingUsd)} a month, GENERATION_ALLOWANCE_USD) leaves no room for this action this month. Only the person running this install can change it.
        </Notice>
      )}
      {error ? <Notice>{error}</Notice> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        {crossing.extendable ? (
          <Button type="submit" disabled={busy || !valid}>{busy ? "Adding…" : "Add and generate"}</Button>
        ) : null}
      </DialogFooter>
    </form>
  );
}
