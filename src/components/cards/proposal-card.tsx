/**
 * The spending gate as a card: recipe, candidate count, estimated cost, prompt, and Approve and
 * generate or Cancel. With auto-approve on, it submits once on mount and says so. When approving
 * would cross this month's remaining budget, nothing runs and the extend dialog opens.
 *
 * Model override (v0.2 F3): the recipe selector lists every recipe for the step's capability on the
 * configured backends. Changing it asks the server for the same proposal with that recipe, so the
 * prompt is rewritten in the model's style and the estimate is redone there (the spend gate prices
 * again at submit). The prompt is editable; an edit is sent flagged and the server bounds it. "Just
 * this run" is the default; "Use for the rest of this project" saves the recipe as the project's
 * preference for the capability once the gate accepts the run (a blocked or failed one saves none). After submitting, "Regenerate with..." proposes
 * the same spec with another recipe as a new card.
 * @packageDocumentation
 */
"use client";

import { Check, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { BudgetDialog } from "@/components/cards/budget-dialog";
import { RecipePicker, styleNote, useRecipeOptions } from "@/components/cards/recipe-picker";
import { ProjectContext } from "@/components/project/project-context";
import { Notice } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { callTool, errorMessage, rerenderProposal, submitProposal } from "@/lib/client/api";
import { CAPABILITY_LABELS, budgetBlock, describeBudgetBlock, describeEstimate, describeSpendWarning, describeTarget, summarizeSubmit } from "@/lib/client/format";
import type { GenerationProposal, SubmitResult } from "@/lib/client/types";
import { EDITED_PROMPT_LIMIT } from "@/lib/domain/shot-spec";
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

type Scope = "run" | "project";

export interface ProposalCardProps {
  proposal: GenerationProposal;
  autoApprove?: boolean;
  /** Called after the gate accepted the proposal, so the page can start polling. */
  onSubmitted?: (results: SubmitResult[]) => void;
  /** Initial state, for rendering a decided card again. */
  initial?: GateState;
}

/** Image references the recipe must take (a voice recording is not one). */
function imageReferences(proposal: GenerationProposal): number {
  return proposal.references.filter((reference) => reference.role !== "voice").length;
}

export function ProposalCard({ proposal: initialProposal, autoApprove = false, onSubmitted, initial }: ProposalCardProps) {
  const project = useContext(ProjectContext);
  const [proposal, setProposal] = useState(initialProposal);
  const rejected = proposal.estimate.kind === "rejected";
  const [gate, setGate] = useState<GateState>(initial ?? (autoApprove && initialProposal.estimate.kind !== "rejected" ? { state: "submitting" } : { state: "pending" }));
  const [warning, setWarning] = useState<SpendWarning>(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState(initialProposal.prompt);
  const [scope, setScope] = useState<Scope>("run");
  const [switching, setSwitching] = useState(false);
  const [switchNote, setSwitchNote] = useState<{ tone: "warn" | "error" | "muted"; text: string } | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const started = useRef(false);
  const pending = gate.state === "pending";
  const edited = draft.trim() !== proposal.prompt.trim();
  const draftTooLong = draft.trim().length > EDITED_PROMPT_LIMIT;
  const draftEmpty = draft.trim().length === 0;
  const optionsWanted = !autoApprove && !initial && (pending || gate.state === "submitted");
  const { view: options, error: optionsError } = useRecipeOptions(project ? proposal.projectId : undefined, { capability: proposal.capability, references: imageReferences(proposal) }, optionsWanted);

  function submit(confirmUnquoted = false) {
    setGate({ state: "submitting" });
    void send(confirmUnquoted);
  }

  /** What goes to the gate: the server's proposal, or with the person's edit flagged as theirs. */
  function submission(): GenerationProposal {
    return edited ? { ...proposal, prompt: draft.trim(), promptEdited: true } : proposal;
  }

  async function send(confirmUnquoted = false) {
    try {
      const { results, warning: level } = await submitProposal(submission(), confirmUnquoted);
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
      // Only a run the gate accepted makes the recipe the project's choice; a blocked, unconfirmed,
      // or failed submission leaves no preference behind.
      if (scope === "project") await savePreference();
    } catch (cause) {
      setGate({ state: "error", message: errorMessage(cause) });
    }
  }

  async function savePreference() {
    try {
      await callTool("set_recipe_preference", { projectId: proposal.projectId, capability: proposal.capability, recipeId: proposal.recipeId }, proposal.projectId);
      project?.notify("ok", `${proposal.recipeTitle} is now this project's ${CAPABILITY_LABELS[proposal.capability].toLowerCase()} recipe.`);
    } catch (cause) {
      project?.notify("warn", `The run was submitted, but the project preference was not saved: ${errorMessage(cause)}`);
    }
  }

  /** Same spec, another recipe: the server rewrites the prompt and redoes the estimate. */
  async function switchRecipe(recipeId: string) {
    if (recipeId === proposal.recipeId) return;
    setSwitching(true);
    setSwitchNote(null);
    try {
      const next = await rerenderProposal(proposal, recipeId);
      const hadEdit = edited;
      setProposal(next);
      setDraft(next.prompt);
      setSwitchNote(
        next.spec?.kind === "free"
          ? { tone: "muted", text: "This prompt was written by hand, so it goes to the new model as written." }
          : hadEdit
            ? { tone: "warn", text: `The prompt was rewritten for ${next.recipeTitle}; your edits were replaced.` }
            : null,
      );
    } catch (cause) {
      setSwitchNote({ tone: "error", text: errorMessage(cause) });
    } finally {
      setSwitching(false);
    }
  }

  async function regenerateWith(recipeId: string) {
    if (!project) return;
    setRegenerating(true);
    try {
      project.propose(await rerenderProposal(proposal, recipeId), "workspace");
    } catch (cause) {
      project.notify("error", errorMessage(cause));
    } finally {
      setRegenerating(false);
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
  const written = styleNote(proposal.promptStyle);
  const canPick = pending && !!project && optionsWanted;

  return (
    <div className="rounded-xl border bg-card p-3 text-sm shadow-xs" data-testid="proposal-card">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <Sparkles className="size-4 text-primary" aria-hidden />
          {describeTarget(proposal.target)}
        </div>
        <Badge variant="secondary">{CAPABILITY_LABELS[proposal.capability]}</Badge>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Recipe</dt>
        <dd className="min-w-0">
          {canPick ? (
            <div className="flex items-center gap-2">
              <RecipePicker view={options} value={proposal.recipeId} currentTitle={proposal.recipeTitle} onChange={(id) => void switchRecipe(id)} disabled={switching} label="Recipe for this proposal" />
              {switching ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Rewriting the prompt" /> : null}
            </div>
          ) : (
            proposal.recipeTitle
          )}
        </dd>
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
      {canPick ? (
        <fieldset className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Where this recipe applies">
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`scope-${initialProposal.id}`} checked={scope === "run"} onChange={() => setScope("run")} />
            Just this run
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`scope-${initialProposal.id}`} checked={scope === "project"} onChange={() => setScope("project")} />
            Use for the rest of this project
          </label>
        </fieldset>
      ) : null}
      {switchNote ? (
        <div className="mt-2">
          <Notice tone={switchNote.tone}>{switchNote.text}</Notice>
        </div>
      ) : null}
      {optionsError && canPick ? <p className="mt-1 text-xs text-muted-foreground">Other recipes could not be listed: {optionsError}</p> : null}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Prompt{written ? ` · ${written}` : ""}
          {edited ? " · edited" : ""}
        </summary>
        {pending ? (
          <div className="mt-1 space-y-1">
            <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={6} aria-label="Prompt" className="text-xs" aria-invalid={draftTooLong || draftEmpty} />
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span className={draftTooLong ? "text-destructive" : undefined}>
                {draft.trim().length.toLocaleString("en-US")} / {EDITED_PROMPT_LIMIT.toLocaleString("en-US")} characters
              </span>
              {edited ? (
                <Button size="xs" variant="ghost" onClick={() => setDraft(proposal.prompt)}>
                  Use the {proposal.recipeTitle.split(" on ")[0]} prompt
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap">{gate.state === "submitted" && edited ? draft.trim() : proposal.prompt}</p>
        )}
      </details>
      {proposal.estimate.note ? <p className="mt-2 text-xs text-muted-foreground">{proposal.estimate.note}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {pending ? (
          <>
            <Button size="sm" onClick={() => submit()} disabled={rejected || switching || draftTooLong || draftEmpty}>
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
        {gate.state === "submitted" && project && options && options.options.length > 1 ? (
          <div className="flex w-full items-center gap-2 text-xs">
            <RefreshCw className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 text-muted-foreground">Regenerate with</span>
            <RecipePicker view={options} value={proposal.recipeId} currentTitle={proposal.recipeTitle} onChange={(id) => void regenerateWith(id)} disabled={regenerating} label="Regenerate with another recipe" excludeCurrent />
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
