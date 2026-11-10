/**
 * Display helpers shared by the cards and pages. Pure and tested.
 * @packageDocumentation
 */
import type { AssetKind } from "@creator-lab/core/domain/asset";
import type { Capability } from "@creator-lab/core/domain/capability";
import type { EstimateSummary, GenerationTarget, JobStatus } from "@creator-lab/core/domain/job";
import { type BudgetCrossing, CREDITS_PER_USD, type SpendWarning } from "@creator-lab/core/domain/spend";
import type { SubmitResult } from "@/lib/client/types";

export const CAPABILITY_LABELS: Record<Capability, string> = {
  text_to_image: "Text to image",
  image_edit: "Image edit with references",
  image_to_video: "Image to video",
  first_last_to_video: "First and last frame to video",
  text_to_video: "Text to video",
  references_to_video: "References to video",
  speech_to_video: "Speech to video (lip sync)",
  text_to_speech: "Text to speech (voice-over)",
  speech_to_text: "Speech to text (transcription)",
  text_generation: "Text generation",
};

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** USD with the Comfy credits beside it: "$4.80 (1,008 credits)". */
export function formatUsdCredits(value: number, creditsPerUsd = CREDITS_PER_USD): string {
  const credits = Math.round(value * creditsPerUsd);
  return `${formatUsd(value)} (${credits.toLocaleString("en-US")} credit${credits === 1 ? "" : "s"})`;
}

/** A budget period boundary as a UTC calendar date, "December 15". */
export function formatPeriodDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** The 50, 80, and 100 percent notices for this month's budget; null below half. */
export function describeSpendWarning(warning: SpendWarning, resetsAt: number | null): { tone: "warn" | "error"; text: string } | null {
  if (warning === 100) {
    const when = resetsAt === null ? "it resets" : `it resets on ${formatPeriodDate(resetsAt)}`;
    return { tone: "error", text: `This month's budget is used up. Paid runs wait until ${when}, or add to this month.` };
  }
  if (warning === 80) return { tone: "warn", text: "80 percent of this month's budget is spent or reserved." };
  if (warning === 50) return { tone: "warn", text: "Half of this month's budget is spent or reserved." };
  return null;
}

/**
 * The amount the extend dialog suggests: what the action needs, rounded up to a whole dollar, never
 * more than the operator ceiling leaves room for.
 */
export function suggestedExtensionUsd(crossing: Pick<BudgetCrossing, "neededUsd" | "maxExtensionUsd">): number {
  const needed = Math.ceil(crossing.neededUsd * 100) / 100;
  return Math.min(Math.max(Math.ceil(needed), needed), crossing.maxExtensionUsd);
}

/** The proposal cost line: per-run estimate times the candidate count. */
export function describeEstimate(estimate: EstimateSummary, count: number): string {
  switch (estimate.kind) {
    case "free":
      return "Free (mock run)";
    case "quoted": {
      const usd = (estimate.usd ?? 0) * count;
      const credits = estimate.credits === null ? "" : ` (${Math.round(estimate.credits * count)} credits)`;
      // A hint is the recipe's ceiling: reserved against the allowance and settled when the run reports its cost.
      return estimate.source === "hint" ? `Up to ${formatUsd(usd)}${credits} reserved` : `About ${formatUsd(usd)}${credits}`;
    }
    case "unquoted":
      return estimate.usd === null ? "No live price" : `Up to ${formatUsd(estimate.usd * count)} reserved (no live price)`;
    case "rejected":
      return "Cannot run";
  }
}

export function describeTarget(target: GenerationTarget): string {
  switch (target.kind) {
    case "character_reference":
      return target.slot === "face" ? "Face reference" : "Body reference";
    case "reference_sheet":
      return "Reference sheet";
    case "product_image":
      return "Product photo";
    case "shot":
      return `Beat ${target.beatIndex} ${target.slot === "voice" ? "voice-over" : target.slot}`;
    case "piece":
      return `${target.slot} still`;
    case "take":
      return target.slot === "clip" ? "Talking recording" : "Recording transcript";
    case "loose":
      return "Loose generation";
  }
}

export function describeJobStatus(status: JobStatus): string {
  const labels: Record<JobStatus, string> = {
    queued: "Queued",
    submitting: "Submitting",
    uncertain: "Checking with the provider",
    running: "Generating",
    retrieving: "Saving the result",
    completed: "Done",
    failed: "Failed",
  };
  return labels[status];
}

/** One sentence summarizing what the gate did with a proposal. */
export function summarizeSubmit(results: SubmitResult[]): { tone: "ok" | "warn" | "error"; text: string } {
  const blocked = results.find((result) => result.outcome === "blocked");
  if (blocked) return { tone: "error", text: blocked.message ?? "This month's budget blocked this run." };
  const confirm = results.find((result) => result.outcome === "needs_confirmation");
  if (confirm) return { tone: "warn", text: confirm.message ?? "This recipe has no live price; confirm a reservation to run it." };
  const failed = results.filter((result) => result.outcome === "failed");
  const running = results.length - failed.length;
  if (failed.length && !running) return { tone: "error", text: failed[0].message ?? "The run failed." };
  const text = `${running} candidate${running === 1 ? "" : "s"} submitted${failed.length ? `, ${failed.length} failed` : ""}.`;
  return { tone: failed.length ? "warn" : "ok", text };
}

/**
 * The budget block in a gate response, if any: the crossing for the extend dialog, and how many of
 * the proposal's candidates already ran (admitted now or by an earlier submission), so the card
 * never says nothing was generated when some were.
 */
export function budgetBlock(results: SubmitResult[]): { crossing: BudgetCrossing; ran: number } | null {
  const blocked = results.find((result) => result.outcome === "blocked" && result.budget);
  if (!blocked?.budget) return null;
  const ran = results.filter((result) => result.job !== null && (result.outcome === "started" || result.outcome === "existing" || result.outcome === "completed")).length;
  return { crossing: blocked.budget, ran };
}

/** The card's line while a proposal waits on the budget. */
export function describeBudgetBlock(ran: number): string {
  if (ran === 0) return "Approving this would go over this month's budget. Nothing was generated.";
  return `${ran} candidate${ran === 1 ? " has" : "s have"} already run; the rest would go over this month's budget and were not started.`;
}

/** Whether the client should keep polling the jobs route. */
export function shouldPoll(unfinished: readonly { status: JobStatus }[]): boolean {
  return unfinished.some((job) => job.status !== "completed" && job.status !== "failed");
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** How each asset kind is labeled, filtered, and rendered. Playable kinds are MP4s with a poster. */
export const ASSET_KINDS: Record<AssetKind, { label: string; plural: string; playable: boolean }> = {
  image: { label: "Image", plural: "Images", playable: false },
  sheet: { label: "Reference sheet", plural: "Reference sheets", playable: false },
  video: { label: "Clip", plural: "Clips", playable: true },
  storyboard: { label: "Storyboard", plural: "Storyboards", playable: false },
  export: { label: "Export", plural: "Exports", playable: true },
  audio: { label: "Voice", plural: "Voice recordings", playable: false },
  transcript: { label: "Transcript", plural: "Transcripts", playable: false },
};

export function assetKindInfo(kind: string): { label: string; plural: string; playable: boolean } {
  return ASSET_KINDS[kind as AssetKind] ?? { label: kind, plural: kind, playable: false };
}
