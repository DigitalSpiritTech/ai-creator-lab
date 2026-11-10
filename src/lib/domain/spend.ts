/**
 * The spend policy: a monthly budget with a reset day, a per-period extension the person adds by
 * hand, and the operator's ceiling (`GENERATION_ALLOWANCE_USD`) that nothing in the app can raise.
 * Everything here is pure; the server sums the period's spend from the job ledger and composes the
 * policy with these functions. USD is the unit; credits are shown beside it at `CREDITS_PER_USD`.
 *
 * Periods are computed in UTC: a period starts at 00:00 UTC on the reset day (1 to 28, so every
 * month has one) and ends at the next month's reset day. The operator ceiling is counted over the
 * calendar month (reset day 1) regardless of the workspace reset day, so changing the reset day in
 * Settings can start a fresh budget period but never a fresh ceiling window.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, TimestampSchema } from "@/lib/domain/common";
import { fail } from "@/lib/domain/failure";

/** The ledger's conversion: 210 credits per USD, the observed Router rate and the Base plan's monthly rate. */
export const CREDITS_PER_USD = 210;

export function usdToCredits(usd: number): number {
  return Math.round(usd * CREDITS_PER_USD * 100) / 100;
}

export function creditsToUsd(credits: number): number {
  return Math.round((credits / CREDITS_PER_USD) * 1e6) / 1e6;
}

/** The largest monthly budget or single extension the app accepts. */
export const MAX_BUDGET_USD = 10_000;
/** Below this, two USD amounts are the same (float sums of cents). */
const EPSILON_USD = 1e-9;

export const BudgetResetDaySchema = z.number().int().min(1).max(28);
export const BudgetAmountSchema = z.number().nonnegative().max(MAX_BUDGET_USD);
/** A period's key: the UTC date it starts, `YYYY-MM-DD`. */
export const PeriodKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the period's start date.");

export const BudgetPeriodSchema = z
  .object({
    key: PeriodKeySchema,
    resetDay: BudgetResetDaySchema,
    /** Inclusive start and exclusive end, epoch milliseconds (UTC midnight on the reset day). */
    startsAt: z.number().int(),
    endsAt: z.number().int(),
  })
  .strict();
export type BudgetPeriod = z.infer<typeof BudgetPeriodSchema>;

/** The budget period that contains `now` for a reset day. */
export function budgetPeriod(now: number, resetDay: number): BudgetPeriod {
  const day = BudgetResetDaySchema.parse(resetDay);
  const date = new Date(now);
  const year = date.getUTCFullYear();
  // Before the reset day, the period began on the reset day of the previous month (Date.UTC rolls -1 into December).
  const month = date.getUTCDate() >= day ? date.getUTCMonth() : date.getUTCMonth() - 1;
  const startsAt = Date.UTC(year, month, day);
  const endsAt = Date.UTC(year, month + 1, day);
  return { key: new Date(startsAt).toISOString().slice(0, 10), resetDay: day, startsAt, endsAt };
}

/** The window the operator ceiling is counted over: the UTC calendar month. */
export function ceilingPeriod(now: number): BudgetPeriod {
  return budgetPeriod(now, 1);
}

export function inPeriod(period: Pick<BudgetPeriod, "startsAt" | "endsAt">, at: number): boolean {
  return at >= period.startsAt && at < period.endsAt;
}

/** Money added to one budget period by a person's click; the next period starts from the base budget again. */
export const BudgetExtensionSchema = z
  .object({
    /** Chosen by the client, so a repeated click adds the money once. */
    id: IdSchema,
    periodKey: PeriodKeySchema,
    amountUsd: z.number().positive().max(MAX_BUDGET_USD),
    createdAt: TimestampSchema,
  })
  .strict();
export type BudgetExtension = z.infer<typeof BudgetExtensionSchema>;

/** The "add to this month" request; `periodKey` is the period the person saw, so a rollover is a conflict. */
export const ExtendBudgetRequestSchema = z
  .object({
    id: IdSchema,
    periodKey: PeriodKeySchema,
    amountUsd: z.number().positive("Enter an amount above zero.").max(MAX_BUDGET_USD),
  })
  .strict();
export type ExtendBudgetRequest = z.infer<typeof ExtendBudgetRequestSchema>;

/** The sum of a period's extensions; extensions of other periods count for nothing. */
export function periodExtensionUsd(extensions: readonly BudgetExtension[], periodKey: string): number {
  return roundUsd(extensions.filter((entry) => entry.periodKey === periodKey).reduce((sum, entry) => sum + entry.amountUsd, 0));
}

/** Settled and outstanding spend in one window. */
export interface SpendTotals {
  spentUsd: number;
  reservedUsd: number;
}

/** The share of this period's budget used (spent plus reserved): 0, 50, 80, or 100 percent. */
export const SpendWarningSchema = z.union([z.literal(0), z.literal(50), z.literal(80), z.literal(100)]);
export type SpendWarning = z.infer<typeof SpendWarningSchema>;

const Usd = z.number().nonnegative();

export const SpendPolicySchema = z
  .object({
    period: BudgetPeriodSchema,
    /** The workspace's monthly budget from Settings. */
    limitUsd: Usd,
    /** Added to this period only. */
    extensionUsd: Usd,
    /** The operator's GENERATION_ALLOWANCE_USD per calendar month; zero keeps paid generation off. */
    ceilingUsd: Usd,
    /** min(limit + extension, ceiling): what this period may spend. */
    effectiveLimitUsd: Usd,
    spentUsd: Usd,
    reservedUsd: Usd,
    /** What the next run may still reserve, under both this period's budget and the ceiling window. */
    remainingUsd: Usd,
    ceilingPeriod: BudgetPeriodSchema,
    ceilingSpentUsd: Usd,
    ceilingReservedUsd: Usd,
    /** The most an extension can add this period before the effective limit meets the ceiling. */
    maxExtensionUsd: Usd,
    warning: SpendWarningSchema,
  })
  .strict();
export type SpendPolicy = z.infer<typeof SpendPolicySchema>;

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** A finite positive ceiling, else zero (paid generation off). */
function sanitizeUsd(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function spendWarning(usedUsd: number, effectiveLimitUsd: number): SpendWarning {
  if (effectiveLimitUsd <= 0) return 0;
  const share = usedUsd / effectiveLimitUsd;
  if (share >= 1 - EPSILON_USD) return 100;
  if (share >= 0.8 - EPSILON_USD) return 80;
  if (share >= 0.5 - EPSILON_USD) return 50;
  return 0;
}

/** Composes the policy in force from the settings, the ceiling, this period's extensions, and the two windows' totals. */
export function composeSpendPolicy(input: {
  period: BudgetPeriod;
  ceilingPeriod: BudgetPeriod;
  limitUsd: number;
  ceilingUsd: number;
  extensionUsd: number;
  totals: SpendTotals;
  ceilingTotals: SpendTotals;
}): SpendPolicy {
  const limitUsd = sanitizeUsd(input.limitUsd);
  const ceilingUsd = sanitizeUsd(input.ceilingUsd);
  const extensionUsd = sanitizeUsd(input.extensionUsd);
  const effectiveLimitUsd = roundUsd(Math.min(limitUsd + extensionUsd, ceilingUsd));
  const budgetLeft = effectiveLimitUsd - input.totals.spentUsd - input.totals.reservedUsd;
  const ceilingLeft = ceilingUsd - input.ceilingTotals.spentUsd - input.ceilingTotals.reservedUsd;
  return SpendPolicySchema.parse({
    period: input.period,
    limitUsd,
    extensionUsd,
    ceilingUsd,
    effectiveLimitUsd,
    spentUsd: roundUsd(input.totals.spentUsd),
    reservedUsd: roundUsd(input.totals.reservedUsd),
    remainingUsd: roundUsd(Math.max(0, Math.min(budgetLeft, ceilingLeft))),
    ceilingPeriod: input.ceilingPeriod,
    ceilingSpentUsd: roundUsd(input.ceilingTotals.spentUsd),
    ceilingReservedUsd: roundUsd(input.ceilingTotals.reservedUsd),
    maxExtensionUsd: roundUsd(Math.max(0, ceilingUsd - limitUsd - extensionUsd)),
    warning: spendWarning(input.totals.spentUsd + input.totals.reservedUsd, effectiveLimitUsd),
  });
}

/** What the approve step shows when a run would cross the remaining budget: the extend modal's numbers. */
export const BudgetCrossingSchema = z
  .object({
    periodKey: PeriodKeySchema,
    periodEndsAt: z.number().int(),
    spentUsd: Usd,
    reservedUsd: Usd,
    remainingUsd: Usd,
    /** This action's cost (all of a proposal's new candidates). */
    costUsd: Usd,
    limitUsd: Usd,
    extensionUsd: Usd,
    effectiveLimitUsd: Usd,
    ceilingUsd: Usd,
    /** cost minus remaining: the least extension that lets this action run. */
    neededUsd: Usd,
    maxExtensionUsd: Usd,
    /** Whether an extension of `neededUsd` would let it run; false when the operator ceiling stands in the way. */
    extendable: z.boolean(),
  })
  .strict();
export type BudgetCrossing = z.infer<typeof BudgetCrossingSchema>;

/** The crossing for an action that costs `costUsd`, or null when it fits in what remains. */
export function budgetCrossing(policy: SpendPolicy, costUsd: number): BudgetCrossing | null {
  if (costUsd <= policy.remainingUsd + EPSILON_USD) return null;
  const neededUsd = roundUsd(costUsd - policy.remainingUsd);
  const ceilingLeft = policy.ceilingUsd - policy.ceilingSpentUsd - policy.ceilingReservedUsd;
  return BudgetCrossingSchema.parse({
    periodKey: policy.period.key,
    periodEndsAt: policy.period.endsAt,
    spentUsd: policy.spentUsd,
    reservedUsd: policy.reservedUsd,
    remainingUsd: policy.remainingUsd,
    costUsd: roundUsd(costUsd),
    limitUsd: policy.limitUsd,
    extensionUsd: policy.extensionUsd,
    effectiveLimitUsd: policy.effectiveLimitUsd,
    ceilingUsd: policy.ceilingUsd,
    neededUsd,
    maxExtensionUsd: policy.maxExtensionUsd,
    extendable: neededUsd <= policy.maxExtensionUsd + EPSILON_USD && costUsd <= ceilingLeft + EPSILON_USD,
  });
}

/** The person-facing sentence for a crossing (the gate's blocked message). */
export function describeCrossing(crossing: BudgetCrossing): string {
  const usd = (value: number) => `$${value.toFixed(2)}`;
  const base = `This run may cost up to ${usd(crossing.costUsd)}, more than the ${usd(crossing.remainingUsd)} left in this month's budget (${usd(crossing.spentUsd)} spent of ${usd(crossing.effectiveLimitUsd)}).`;
  return crossing.extendable
    ? `${base} Add at least ${usd(crossing.neededUsd)} to this month to run it.`
    : `${base} The operator ceiling of ${usd(crossing.ceilingUsd)} a month leaves no room to extend.`;
}

/**
 * Validates an "add to this month" request against the policy in force and returns the extension
 * to save. The period must still be the one the person saw, and the effective limit may not rise
 * above the operator ceiling; a zero ceiling refuses every extension.
 */
export function extendBudget(policy: SpendPolicy, request: ExtendBudgetRequest, now: number): BudgetExtension {
  const parsed = ExtendBudgetRequestSchema.parse(request);
  if (parsed.periodKey !== policy.period.key) {
    fail("conflict", "A new budget period has started since this was opened. Reload to see this month's budget.");
  }
  if (policy.ceilingUsd <= 0) {
    fail("invalid", "Paid generation is off on this install (GENERATION_ALLOWANCE_USD is zero), so the budget cannot be extended.");
  }
  if (parsed.amountUsd > policy.maxExtensionUsd + EPSILON_USD) {
    fail(
      "invalid",
      policy.maxExtensionUsd <= 0
        ? `This month is already at the operator ceiling of $${policy.ceilingUsd.toFixed(2)}.`
        : `At most $${policy.maxExtensionUsd.toFixed(2)} can be added this month; the operator ceiling is $${policy.ceilingUsd.toFixed(2)} a month.`,
    );
  }
  return BudgetExtensionSchema.parse({ id: parsed.id, periodKey: parsed.periodKey, amountUsd: roundUsd(parsed.amountUsd), createdAt: now });
}
