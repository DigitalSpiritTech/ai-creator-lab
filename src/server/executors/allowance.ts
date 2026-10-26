/**
 * Spending guard for paid generation: a USD allowance from GENERATION_ALLOWANCE_USD, live Router quotes
 * where the model offers one, reservations from a recipe's ceiling where it does not, and the Comfy
 * credit balance for settling real cost. Zero allowance blocks every paid submission.
 * @packageDocumentation
 */
import { z } from "zod";
import { jobError } from "@/server/executors/jobs";
import type { Recipe } from "@/lib/catalog";
import type { EstimateOutcome, JobError } from "@/server/executors/types";

/** The ledger's conversion: 210 credits per USD, the observed Router rate and the Base plan's monthly rate. */
export const CREDITS_PER_USD = 210;
/** The Cloud UI's credit count is `effective_balance_cents` times this factor. */
export const CREDITS_PER_BALANCE_CENT = 2.11;

export function creditsToUsd(credits: number): number {
  return Math.round((credits / CREDITS_PER_USD) * 1e6) / 1e6;
}

export function usdToCredits(usd: number): number {
  return Math.round(usd * CREDITS_PER_USD * 100) / 100;
}

/** Reads the allowance; anything missing, negative, or malformed counts as zero (paid runs off). */
export function readAllowanceUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GENERATION_ALLOWANCE_USD?.trim();
  if (!raw || !/^\d+(\.\d{1,6})?$/.test(raw)) return 0;
  return Number(raw);
}

export interface AllowanceState {
  allowanceUsd: number;
  /** Settled spend from credits headers or the balance. */
  spentUsd: number;
  /** Outstanding reservations of jobs not yet settled. */
  reservedUsd: number;
}

export type AllowanceDecision =
  | { kind: "allowed"; reserveUsd: number; remainingUsd: number }
  | { kind: "confirm"; reserveUsd: number; remainingUsd: number; reason: string }
  | { kind: "blocked"; error: JobError };

/**
 * Decides whether a priced (or unpriced) request may run under the allowance.
 * Free runs always pass; a quote reserves its amount; an unquoted run reserves the recipe ceiling and
 * needs the user's explicit confirmation; anything over the remaining allowance is blocked.
 */
export function checkAllowance(state: AllowanceState, estimate: EstimateOutcome, recipe: Pick<Recipe, "ceilingUsd" | "title">): AllowanceDecision {
  if (estimate.kind === "free") return { kind: "allowed", reserveUsd: 0, remainingUsd: Math.max(0, state.allowanceUsd - state.spentUsd - state.reservedUsd) };
  if (estimate.kind === "rejected") return { kind: "blocked", error: estimate.error };
  if (state.allowanceUsd <= 0) {
    return { kind: "blocked", error: jobError("budget", "Paid generation is off. Set GENERATION_ALLOWANCE_USD in .env.local to allow it.") };
  }
  const remainingUsd = state.allowanceUsd - state.spentUsd - state.reservedUsd;
  const reserveUsd = estimate.kind === "quoted" ? estimate.usd : (estimate.ceilingUsd ?? recipe.ceilingUsd);
  if (reserveUsd === undefined || reserveUsd === null) {
    return { kind: "blocked", error: jobError("budget", `${recipe.title} has no price or ceiling, so it cannot be reserved against the allowance.`) };
  }
  if (reserveUsd > remainingUsd) {
    return { kind: "blocked", error: jobError("budget", `This run may cost up to $${reserveUsd.toFixed(2)}, more than the $${Math.max(0, remainingUsd).toFixed(2)} left in the allowance.`) };
  }
  if (estimate.kind === "unquoted") {
    return { kind: "confirm", reserveUsd, remainingUsd: remainingUsd - reserveUsd, reason: `${estimate.note} Up to $${reserveUsd.toFixed(2)} will be reserved.` };
  }
  return { kind: "allowed", reserveUsd, remainingUsd: remainingUsd - reserveUsd };
}

/** Converts a settled credits figure to USD, falling back to the reservation when nothing was reported. */
export function settleUsd(creditsUsed: number | null, reservedUsd: number): number {
  return creditsUsed === null ? reservedUsd : creditsToUsd(creditsUsed);
}

const BalanceSchema = z.object({ effective_balance_cents: z.number() }).passthrough();

/** Reads the Comfy credit balance. It lags a finished run by up to a minute; settle later, not immediately. */
export async function readCreditBalance(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<{ cents: number; credits: number }> {
  if (!apiKey) throw jobError("provider", "Set COMFY_API_KEY to read the credit balance.");
  const response = await fetchImpl("https://cloud.comfy.org/api/billing/balance", {
    headers: { "X-API-Key": apiKey },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
  if (!response?.ok) {
    await response?.body?.cancel();
    throw jobError("provider", "The Comfy credit balance could not be read.", true);
  }
  const parsed = BalanceSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw jobError("provider", "The Comfy credit balance response was not understood.", true);
  const cents = parsed.data.effective_balance_cents;
  return { cents, credits: Math.round(cents * CREDITS_PER_BALANCE_CENT) };
}

const DecimalSchema = z.string().regex(/^\d{1,5}(\.\d{1,8})?$/);
const QuoteSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("exact"), amount: DecimalSchema, currency: z.literal("USD") }).passthrough(),
  z.object({ source: z.literal("estimated"), min_amount: DecimalSchema, max_amount: DecimalSchema, currency: z.literal("USD") }).passthrough(),
  z.object({ source: z.literal("unknown"), reason: z.string() }).passthrough(),
]);

/**
 * Asks Router to price a native body without generating (`POST /v2/models/{id}/estimate`).
 * Unavailable or unknown pricing becomes `unquoted`; an estimated range reserves its upper bound.
 */
export async function quoteRouter(apiKey: string, model: string, body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<EstimateOutcome> {
  const unquoted = (note: string): EstimateOutcome => ({ kind: "unquoted", ceilingUsd: null, note });
  if (!/^[\w.-]+\/[\w.-]+$/.test(model)) return { kind: "rejected", error: jobError("invalid", "Unknown Router model id.") };
  const response = await fetchImpl(`https://api.comfy.org/v2/models/${model}/estimate`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
  if (!response) return unquoted("Live pricing could not be reached.");
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) return { kind: "rejected", error: jobError("provider", "Comfy rejected the API key.") };
    if (response.status === 402) return { kind: "rejected", error: jobError("budget", "Your Comfy account needs credits before generating.") };
    if (response.status === 422) return { kind: "rejected", error: jobError("invalid", "Router rejected these settings for this model.") };
    return unquoted("Live pricing is unavailable for this model.");
  }
  const quote = QuoteSchema.safeParse(await response.json().catch(() => undefined));
  if (!quote.success) return unquoted("Router's price could not be read.");
  if (quote.data.source === "unknown") return unquoted("Router cannot price this request before it runs.");
  const usd = Number(quote.data.source === "exact" ? quote.data.amount : quote.data.max_amount);
  const note = quote.data.source === "exact" ? "Live Router quote." : `Router estimates $${quote.data.min_amount} to $${quote.data.max_amount}; the upper bound is reserved.`;
  return { kind: "quoted", usd, credits: usdToCredits(usd), source: "live", note };
}
