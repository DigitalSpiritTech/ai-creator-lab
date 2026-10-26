/**
 * Display helpers shared by the cards and pages. Pure and tested.
 * @packageDocumentation
 */
import type { AssetKind } from "@/lib/domain/asset";
import type { Capability } from "@/lib/domain/capability";
import type { EstimateSummary, GenerationTarget, JobStatus } from "@/lib/domain/job";
import type { SubmitResult } from "@/lib/client/types";

export const CAPABILITY_LABELS: Record<Capability, string> = {
  text_to_image: "Text to image",
  image_edit: "Image edit with references",
  image_to_video: "Image to video",
  first_last_to_video: "First and last frame to video",
  text_to_video: "Text to video",
  references_to_video: "References to video",
  text_generation: "Text generation",
};

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** The proposal cost line: per-run estimate times the candidate count. */
export function describeEstimate(estimate: EstimateSummary, count: number): string {
  switch (estimate.kind) {
    case "free":
      return "Free (mock run)";
    case "quoted": {
      const usd = (estimate.usd ?? 0) * count;
      const credits = estimate.credits === null ? "" : ` (${Math.round(estimate.credits * count)} credits)`;
      return `About ${formatUsd(usd)}${credits}`;
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
    case "shot":
      return `Beat ${target.beatIndex} ${target.slot}`;
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
  if (blocked) return { tone: "error", text: blocked.message ?? "The allowance blocked this run." };
  const confirm = results.find((result) => result.outcome === "needs_confirmation");
  if (confirm) return { tone: "warn", text: confirm.message ?? "This recipe has no live price; confirm a reservation to run it." };
  const failed = results.filter((result) => result.outcome === "failed");
  const running = results.length - failed.length;
  if (failed.length && !running) return { tone: "error", text: failed[0].message ?? "The run failed." };
  const text = `${running} candidate${running === 1 ? "" : "s"} submitted${failed.length ? `, ${failed.length} failed` : ""}.`;
  return { tone: failed.length ? "warn" : "ok", text };
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
};

export function assetKindInfo(kind: string): { label: string; plural: string; playable: boolean } {
  return ASSET_KINDS[kind as AssetKind] ?? { label: kind, plural: kind, playable: false };
}
