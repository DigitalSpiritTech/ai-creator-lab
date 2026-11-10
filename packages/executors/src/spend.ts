/**
 * The spend policy in force, settled from the job ledger: what each job has cost (`chargedUsd`),
 * which period that cost falls in (when it was captured), this period's extensions, and the
 * operator ceiling from GENERATION_ALLOWANCE_USD. The run gate, Settings, and the extend route all
 * read the policy from here, so they never disagree.
 * @packageDocumentation
 */
import type { Job } from "@creator-lab/core/domain/job";
import {
  type BudgetExtension,
  type BudgetPeriod,
  type ExtendBudgetRequest,
  type SpendPolicy,
  type SpendTotals,
  budgetPeriod,
  ceilingPeriod,
  composeSpendPolicy,
  extendBudget,
  inPeriod,
  periodExtensionUsd,
} from "@creator-lab/core/domain/spend";
import type { WorkspaceSettings } from "@creator-lab/core/domain/workspace";
import { readAllowanceUsd, settleUsd } from "./allowance";

/** How long a provider will still answer for a request under the same idempotency key. */
export const COLLECTION_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * The part of the app's store the spend policy reads and writes: workspace settings (budget and
 * reset day), the job ledger, and budget extensions. The app's SQLite store satisfies it.
 */
export interface SpendStore {
  workspace: { get(): WorkspaceSettings };
  jobs: { listAll(): Job[] };
  budget: {
    get(id: string): BudgetExtension | undefined;
    listForPeriod(periodKey: string): BudgetExtension[];
    add(extension: BudgetExtension): { extension: BudgetExtension; created: boolean };
  };
  transaction<T>(run: () => T): T;
}

/** What the spend policy needs: the store, a clock, and optional overrides for tests and scripts. */
export interface SpendDeps {
  store: SpendStore;
  now?: () => number;
  /**
   * A flat cap in USD that replaces the monthly budget, extension, and operator ceiling (tests and
   * spike scripts that hold their own cap). Periods still apply.
   */
  allowanceUsd?: () => number;
  /** The operator ceiling; defaults to GENERATION_ALLOWANCE_USD read on every call. */
  operatorCeilingUsd?: () => number;
}

/**
 * What a job counts against the budget. Reported credits win. A failure before anything reached
 * a provider (no provider reference, error not from the provider) costs nothing; other failures and
 * completions without a report keep their reservation. Unfinished jobs hold their reservation,
 * except uncertain ones past the collection window, which are settled at zero. Unpriced mock runs
 * are free.
 */
export function chargedUsd(job: Job, now: number): { spentUsd: number; reservedUsd: number } {
  const reserved = job.reservedUsd ?? 0;
  if (job.executor === "mock" && job.reservedUsd === null) return { spentUsd: 0, reservedUsd: 0 };
  if (job.status === "completed") return { spentUsd: settleUsd(job.creditsUsed, reserved), reservedUsd: 0 };
  if (job.status === "failed") {
    if (job.creditsUsed !== null) return { spentUsd: settleUsd(job.creditsUsed, reserved), reservedUsd: 0 };
    const local = job.providerRef === null && job.error.code !== "provider";
    return { spentUsd: local ? 0 : reserved, reservedUsd: 0 };
  }
  if (job.status === "uncertain" && now - job.createdAt > COLLECTION_WINDOW_MS) return { spentUsd: 0, reservedUsd: 0 };
  return { spentUsd: 0, reservedUsd: reserved };
}

/** When a settled job's cost was captured: completion or failure. Null while it is unfinished. */
export function settledAt(job: Job): number | null {
  if (job.status === "completed") return job.completedAt;
  if (job.status === "failed") return job.failedAt;
  return null;
}

/**
 * Spend in a window that contains `now`: settled costs captured inside it, plus every outstanding
 * reservation (an unfinished job will settle now or later, never in a past period).
 */
export function windowTotals(jobs: readonly Job[], window: Pick<BudgetPeriod, "startsAt" | "endsAt">, now: number): SpendTotals {
  let spentUsd = 0;
  let reservedUsd = 0;
  for (const job of jobs) {
    const charge = chargedUsd(job, now);
    reservedUsd += charge.reservedUsd;
    const at = settledAt(job);
    if (charge.spentUsd > 0 && at !== null && inPeriod(window, at)) spentUsd += charge.spentUsd;
  }
  return { spentUsd, reservedUsd };
}

/** The policy in force now: this period's budget, extension, spend, and the operator ceiling. */
export function currentSpendPolicy(deps: SpendDeps): SpendPolicy {
  const now = (deps.now ?? Date.now)();
  const settings = deps.store.workspace.get();
  const period = budgetPeriod(now, settings.budgetResetDay);
  const jobs = deps.store.jobs.listAll();
  const totals = windowTotals(jobs, period, now);
  if (deps.allowanceUsd) {
    const cap = deps.allowanceUsd();
    return composeSpendPolicy({ period, ceilingPeriod: period, limitUsd: cap, ceilingUsd: cap, extensionUsd: 0, totals, ceilingTotals: totals });
  }
  const ceiling = ceilingPeriod(now);
  const ceilingTotals = ceiling.key === period.key ? totals : windowTotals(jobs, ceiling, now);
  return composeSpendPolicy({
    period,
    ceilingPeriod: ceiling,
    limitUsd: settings.monthlyBudgetUsd,
    ceilingUsd: (deps.operatorCeilingUsd ?? readAllowanceUsd)(),
    extensionUsd: periodExtensionUsd(deps.store.budget.listForPeriod(period.key), period.key),
    totals,
    ceilingTotals,
  });
}

/**
 * "Add to this month": saves an extension for the current period after checking it against the
 * policy in force. A repeated request id returns the saved extension without adding again. Only a
 * person's click reaches this (the Settings and approve-step route); it is not a tool, so neither
 * the assistant nor the MCP server can raise the budget.
 */
export function addBudgetExtension(deps: SpendDeps, request: ExtendBudgetRequest): { extension: BudgetExtension; created: boolean; policy: SpendPolicy } {
  return deps.store.transaction(() => {
    const existing = deps.store.budget.get(request.id);
    if (existing) return { extension: existing, created: false, policy: currentSpendPolicy(deps) };
    const extension = extendBudget(currentSpendPolicy(deps), request, (deps.now ?? Date.now)());
    const saved = deps.store.budget.add(extension);
    return { ...saved, policy: currentSpendPolicy(deps) };
  });
}
