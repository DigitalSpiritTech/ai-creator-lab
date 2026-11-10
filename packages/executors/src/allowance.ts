/**
 * Spending guard for paid generation: the spend policy (monthly budget, this period's extension,
 * and the operator ceiling GENERATION_ALLOWANCE_USD), live Router quotes where the model offers one,
 * reservations from a recipe's ceiling where it does not, and the Comfy credit balance for settling
 * real cost. A zero operator ceiling blocks every paid submission.
 * @packageDocumentation
 */
import { z } from "zod";
import {
  type BudgetCrossing,
  type SpendPolicy,
  budgetCrossing,
  budgetPeriod,
  composeSpendPolicy,
  creditsToUsd,
  describeCrossing,
  usdToCredits,
} from "@creator-lab/core/domain/spend";
import { jobError } from "./jobs";
import type { Recipe } from "@creator-lab/core/catalog";
import type { EstimateOutcome, JobError } from "./types";

/** The ledger's conversion (210 credits per USD) lives with the spend policy so the UI can show credits too. */
export { CREDITS_PER_USD, creditsToUsd, usdToCredits } from "@creator-lab/core/domain/spend";
/** The Cloud UI's credit count is `effective_balance_cents` times this factor. */
export const CREDITS_PER_BALANCE_CENT = 2.11;

/** Reads the operator ceiling; anything missing, negative, or malformed counts as zero (paid runs off). */
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
  /** `budget` is set when the run would cross this period's remaining budget: the extend modal's numbers. */
  | { kind: "blocked"; error: JobError; budget?: BudgetCrossing };

export const PAID_GENERATION_OFF = "Paid generation is off. Set GENERATION_ALLOWANCE_USD in .env.local to allow it.";

/** What an estimate reserves: zero when free, the quote, else the ceiling; undefined when there is neither. */
export function reservationUsd(estimate: EstimateOutcome, recipe: Pick<Recipe, "ceilingUsd">): number | undefined {
  if (estimate.kind === "free" || estimate.kind === "rejected") return 0;
  const reserve = estimate.kind === "quoted" ? estimate.usd : (estimate.ceilingUsd ?? recipe.ceilingUsd);
  return reserve === null || reserve === undefined ? undefined : reserve;
}

/**
 * Decides whether a priced (or unpriced) request may run under the spend policy.
 * Free runs always pass; a quote reserves its amount; an unquoted run reserves the recipe ceiling and
 * needs the user's explicit confirmation; a zero operator ceiling blocks every paid run; anything
 * over the remaining budget is blocked with the crossing the extend modal shows.
 */
export function checkSpend(policy: SpendPolicy, estimate: EstimateOutcome, recipe: Pick<Recipe, "ceilingUsd" | "title">): AllowanceDecision {
  if (estimate.kind === "free") return { kind: "allowed", reserveUsd: 0, remainingUsd: policy.remainingUsd };
  if (estimate.kind === "rejected") return { kind: "blocked", error: estimate.error };
  if (policy.ceilingUsd <= 0) return { kind: "blocked", error: jobError("budget", PAID_GENERATION_OFF) };
  const reserveUsd = reservationUsd(estimate, recipe);
  if (reserveUsd === undefined) {
    return { kind: "blocked", error: jobError("budget", `${recipe.title} has no price or ceiling, so it cannot be reserved against the budget.`) };
  }
  const crossing = budgetCrossing(policy, reserveUsd);
  if (crossing) return { kind: "blocked", error: jobError("budget", describeCrossing(crossing)), budget: crossing };
  const remainingUsd = Math.round((policy.remainingUsd - reserveUsd) * 1e6) / 1e6;
  if (estimate.kind === "unquoted") {
    return { kind: "confirm", reserveUsd, remainingUsd, reason: `${estimate.note} Up to $${reserveUsd.toFixed(2)} will be reserved.` };
  }
  return { kind: "allowed", reserveUsd, remainingUsd };
}

/**
 * `checkSpend` for a flat cap without periods or extensions (the cap is both the budget and the
 * ceiling), for callers that hold only totals, such as executor tests.
 */
export function checkAllowance(state: AllowanceState, estimate: EstimateOutcome, recipe: Pick<Recipe, "ceilingUsd" | "title">): AllowanceDecision {
  const period = budgetPeriod(0, 1);
  const totals = { spentUsd: state.spentUsd, reservedUsd: state.reservedUsd };
  const policy = composeSpendPolicy({ period, ceilingPeriod: period, limitUsd: state.allowanceUsd, ceilingUsd: state.allowanceUsd, extensionUsd: 0, totals, ceilingTotals: totals });
  return checkSpend(policy, estimate, recipe);
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
