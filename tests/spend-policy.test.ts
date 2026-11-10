/**
 * The spend policy (v0.2 F2): monthly periods with a reset day, settlement of this period's spend
 * from captured job costs, the per-period extension, and the operator ceiling. The acceptance run
 * goes through the real spending gate (`submit_proposal`) with a priced mock executor and a fake
 * clock: no network, no credits.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import type { Recipe } from "@/lib/catalog";
import { toFailure } from "@/lib/domain/failure";
import { advanceJob, createJob, type GenerationProposal, type Job } from "@/lib/domain/job";
import {
  type BudgetPeriod,
  type SpendPolicy,
  budgetCrossing,
  budgetPeriod,
  ceilingPeriod,
  composeSpendPolicy,
  extendBudget,
  periodExtensionUsd,
  spendWarning,
} from "@/lib/domain/spend";
import { MOCK_RECIPES } from "@/server/catalog/defaults";
import { MockExecutor } from "@/server/executors";
import { PAID_GENERATION_OFF } from "@/server/executors/allowance";
import { addBudgetExtension, currentSpendPolicy, windowTotals } from "@/server/executors/spend";
import { AGENT_TOOLS, INTERNAL_TOOLS, TOOLS, callTool } from "@/server/tools";
import { buildProposal } from "@/server/tools/proposals";
import type { ToolContext } from "@/server/tools/registry";
import { seedProject, tempStore } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const utc = (year: number, month: number, day: number, hour = 0, minute = 0) => Date.UTC(year, month - 1, day, hour, minute);
const date = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
const span = (period: BudgetPeriod) => `${date(period.startsAt)}..${date(period.endsAt)}`;

describe("budget periods", () => {
  test("reset day 15: the 14th belongs to the previous period, the 15th starts a new one", () => {
    assert.equal(span(budgetPeriod(utc(2026, 11, 14, 23, 59), 15)), "2026-10-15..2026-11-15");
    assert.equal(budgetPeriod(utc(2026, 11, 14, 23, 59), 15).key, "2026-10-15");
    assert.equal(span(budgetPeriod(utc(2026, 11, 15), 15)), "2026-11-15..2026-12-15");
    assert.equal(budgetPeriod(utc(2026, 11, 15) - 1, 15).key, "2026-10-15", "one millisecond before midnight UTC");
    assert.equal(span(budgetPeriod(utc(2026, 11, 30, 12), 15)), "2026-11-15..2026-12-15");
  });

  test("December rolls into January and January reaches back into December", () => {
    assert.equal(span(budgetPeriod(utc(2026, 12, 20), 15)), "2026-12-15..2027-01-15");
    assert.equal(span(budgetPeriod(utc(2027, 1, 10), 15)), "2026-12-15..2027-01-15");
    assert.equal(span(budgetPeriod(utc(2026, 12, 31, 23, 59), 1)), "2026-12-01..2027-01-01");
    assert.equal(span(budgetPeriod(utc(2027, 1, 1), 1)), "2027-01-01..2027-02-01");
  });

  test("reset day 28 works in February, leap year or not; days outside 1 to 28 are refused", () => {
    assert.equal(span(budgetPeriod(utc(2027, 2, 27), 28)), "2027-01-28..2027-02-28");
    assert.equal(span(budgetPeriod(utc(2027, 3, 1), 28)), "2027-02-28..2027-03-28");
    assert.equal(span(budgetPeriod(utc(2028, 2, 29), 28)), "2028-02-28..2028-03-28");
    assert.throws(() => budgetPeriod(utc(2026, 11, 1), 29));
    assert.throws(() => budgetPeriod(utc(2026, 11, 1), 0));
    assert.equal(ceilingPeriod(utc(2026, 11, 20)).key, "2026-11-01");
  });
});

function policy(input: { limit: number; ceiling: number; extension?: number; spent?: number; reserved?: number; ceilingSpent?: number; now?: number; resetDay?: number }): SpendPolicy {
  const now = input.now ?? utc(2026, 11, 20);
  const totals = { spentUsd: input.spent ?? 0, reservedUsd: input.reserved ?? 0 };
  return composeSpendPolicy({
    period: budgetPeriod(now, input.resetDay ?? 1),
    ceilingPeriod: ceilingPeriod(now),
    limitUsd: input.limit,
    ceilingUsd: input.ceiling,
    extensionUsd: input.extension ?? 0,
    totals,
    ceilingTotals: input.ceilingSpent === undefined ? totals : { spentUsd: input.ceilingSpent, reservedUsd: totals.reservedUsd },
  });
}

describe("spend policy (pure)", () => {
  test("the effective limit is the budget plus this period's extension, never above the operator ceiling", () => {
    assert.equal(policy({ limit: 5, ceiling: 10 }).effectiveLimitUsd, 5);
    assert.equal(policy({ limit: 5, ceiling: 10, extension: 1 }).effectiveLimitUsd, 6);
    assert.equal(policy({ limit: 5, ceiling: 5.5, extension: 1 }).effectiveLimitUsd, 5.5, "an extension cannot pass the ceiling");
    assert.equal(policy({ limit: 20, ceiling: 10 }).effectiveLimitUsd, 10);
    assert.equal(policy({ limit: 20, ceiling: 10 }).maxExtensionUsd, 0);
    assert.equal(policy({ limit: 5, ceiling: 0, extension: 3 }).effectiveLimitUsd, 0, "a zero ceiling turns paid runs off");
    assert.equal(policy({ limit: 5, ceiling: Number.NaN }).ceilingUsd, 0);
  });

  test("remaining is the tighter of this period's budget and the ceiling's calendar month", () => {
    assert.equal(policy({ limit: 5, ceiling: 10, spent: 4.8 }).remainingUsd, 0.2);
    assert.equal(policy({ limit: 5, ceiling: 10, spent: 1, reserved: 0.5 }).remainingUsd, 3.5);
    assert.equal(policy({ limit: 5, ceiling: 6, spent: 1, ceilingSpent: 5.5, resetDay: 15 }).remainingUsd, 0.5);
    assert.equal(policy({ limit: 5, ceiling: 10, spent: 7 }).remainingUsd, 0);
  });

  test("the most an extension can add stops where the ceiling's calendar month runs out", () => {
    assert.equal(policy({ limit: 5, ceiling: 10, spent: 4, ceilingSpent: 7, resetDay: 15 }).maxExtensionUsd, 2, "3 left in the month, 1 left in the budget");
    assert.equal(policy({ limit: 5, ceiling: 6, spent: 0, ceilingSpent: 5.5, resetDay: 15 }).maxExtensionUsd, 0, "the month has less left than the budget");
    assert.equal(policy({ limit: 5, ceiling: 10, spent: 4.8 }).maxExtensionUsd, 5, "same window: only the limit's headroom applies");
    const capped = policy({ limit: 5, ceiling: 10, spent: 4, ceilingSpent: 7, resetDay: 15 });
    const id = randomUUID();
    assert.throws(() => extendBudget(capped, { id, periodKey: capped.period.key, amountUsd: 2.5 }, 1), (error) => /At most \$2\.00/.test(toFailure(error).message));
    const added = extendBudget(capped, { id, periodKey: capped.period.key, amountUsd: 2 }, 1);
    const after = policy({ limit: 5, ceiling: 10, extension: added.amountUsd, spent: 4, ceilingSpent: 7, resetDay: 15 });
    assert.equal(after.remainingUsd, 3, "every dollar added is usable");
    assert.equal(after.maxExtensionUsd, 0);
  });

  test("50, 80, and 100 percent warnings count spent plus reserved", () => {
    assert.equal(spendWarning(2.49, 5), 0);
    assert.equal(spendWarning(2.5, 5), 50);
    assert.equal(spendWarning(4, 5), 80);
    assert.equal(spendWarning(5, 5), 100);
    assert.equal(spendWarning(1, 0), 0);
    assert.equal(policy({ limit: 5, ceiling: 10, spent: 3, reserved: 1 }).warning, 80);
  });

  test("a crossing carries spent, remaining, cost, and whether an extension can cover it", () => {
    const current = policy({ limit: 5, ceiling: 10, spent: 4.8 });
    assert.equal(budgetCrossing(current, 0.2), null, "exactly the remaining amount fits");
    const crossing = budgetCrossing(current, 0.5)!;
    assert.equal(crossing.spentUsd, 4.8);
    assert.equal(crossing.remainingUsd, 0.2);
    assert.equal(crossing.costUsd, 0.5);
    assert.equal(crossing.neededUsd, 0.3);
    assert.equal(crossing.maxExtensionUsd, 5);
    assert.equal(crossing.extendable, true);
    assert.equal(crossing.periodKey, "2026-11-01");
    const capped = budgetCrossing(policy({ limit: 5, ceiling: 5, spent: 4.8 }), 0.5)!;
    assert.equal(capped.extendable, false, "the ceiling leaves no room");
    const calendar = budgetCrossing(policy({ limit: 5, ceiling: 6, spent: 0, ceilingSpent: 5.8, resetDay: 15 }), 0.5)!;
    assert.equal(calendar.extendable, false, "an extension cannot lift the ceiling's calendar month");
  });

  test("extending: same period only, positive, within the ceiling, and refused at a zero ceiling", () => {
    const current = policy({ limit: 5, ceiling: 6, spent: 4.8 });
    const id = randomUUID();
    const extension = extendBudget(current, { id, periodKey: "2026-11-01", amountUsd: 1 }, 7);
    assert.deepEqual(extension, { id, periodKey: "2026-11-01", amountUsd: 1, createdAt: 7 });
    const code = (work: () => unknown) => {
      try {
        work();
        return "ok";
      } catch (error) {
        return toFailure(error).code;
      }
    };
    assert.equal(code(() => extendBudget(current, { id, periodKey: "2026-10-01", amountUsd: 1 }, 7)), "conflict");
    assert.equal(code(() => extendBudget(current, { id, periodKey: "2026-11-01", amountUsd: 1.01 }, 7)), "invalid");
    assert.equal(code(() => extendBudget(current, { id, periodKey: "2026-11-01", amountUsd: 0 }, 7)), "invalid");
    assert.throws(
      () => extendBudget(current, { id, periodKey: "2026-11-01", amountUsd: 1e-9 }, 7),
      (error) => toFailure(error).code === "invalid" && toFailure(error).message === "Enter at least $0.01 to add to this month.",
      "a tiny amount gets the friendly message, not a raw schema error",
    );
    assert.equal(code(() => extendBudget(policy({ limit: 5, ceiling: 0 }), { id, periodKey: "2026-11-01", amountUsd: 1 }, 7)), "invalid");
    assert.equal(periodExtensionUsd([extension, { ...extension, id: randomUUID(), periodKey: "2026-10-01" }], "2026-11-01"), 1);
  });
});

describe("settlement from captured costs", () => {
  const recipe = MOCK_RECIPES.find((entry) => entry.capability === "text_to_image")!;
  const job = (reservedUsd: number, createdAt: number): Job =>
    createJob({ id: randomUUID(), requestId: randomUUID(), projectId: randomUUID(), request: { recipe, input: { prompt: "x" } }, reservedUsd }, createdAt);
  const failedAt = (reservedUsd: number, at: number): Job =>
    advanceJob(advanceJob(job(reservedUsd, at - 10), { status: "running", providerRef: "p" }, at - 5), { status: "failed", error: { code: "provider", message: "No.", retryable: false } }, at);

  test("only costs captured in the period count; outstanding reservations always count", () => {
    const november = budgetPeriod(utc(2026, 11, 20), 1);
    const jobs = [failedAt(1, utc(2026, 10, 31, 23, 59)), failedAt(0.4, utc(2026, 11, 2)), job(0.25, utc(2026, 10, 30))];
    assert.deepEqual(windowTotals(jobs, november, utc(2026, 11, 20)), { spentUsd: 0.4, reservedUsd: 0.25 });
    const october = budgetPeriod(utc(2026, 10, 20), 1);
    assert.deepEqual(windowTotals(jobs, october, utc(2026, 10, 31, 23, 59)), { spentUsd: 1, reservedUsd: 0.25 });
  });
});

/** A tool context over a temporary store whose mock executor charges `price(prompt)` per run. */
function setup(options: { ceiling: number; budget: number; resetDay?: number; start: number }) {
  const { store, cleanup } = tempStore();
  cleanups.push(cleanup);
  let time = options.start;
  const now = () => time;
  const prices: Record<string, number> = {};
  const mock = new MockExecutor({ jobs: store.jobs, now, price: (input) => prices[input.prompt] });
  const recipes: Recipe[] = MOCK_RECIPES;
  let ceiling = options.ceiling;
  const context: ToolContext = {
    store,
    now,
    newId: randomUUID,
    generation: { executors: { mock, forRecipe: () => mock }, recipes: async () => recipes, operatorCeilingUsd: () => ceiling, sleep: async () => undefined },
  };
  store.workspace.update({ monthlyBudgetUsd: options.budget, budgetResetDay: options.resetDay ?? 1 }, time);
  const project = seedProject(store, now);
  return {
    store,
    context,
    project,
    deps: { store, now, operatorCeilingUsd: () => ceiling },
    setTime: (next: number) => {
      time = next;
    },
    setCeiling: (next: number) => {
      ceiling = next;
    },
    async propose(prompt: string, usd: number, count = 1): Promise<GenerationProposal> {
      prices[prompt] = usd;
      return buildProposal(context, { projectId: project.id, capability: "text_to_image", prompt, references: [], count, target: { kind: "loose" } });
    },
    async submit(proposal: GenerationProposal) {
      const result = await callTool(context, "submit_proposal", { proposal, wait: true });
      assert.ok(result.ok, result.ok ? "" : result.failure.message);
      return result.output as { results: { outcome: string; job: Job | null; assetIds: string[]; message: string | null; budget: ReturnType<typeof budgetCrossing> }[]; warning: number };
    },
  };
}

describe("acceptance: a 5 USD monthly budget with an extension", () => {
  test("blocked at 4.80 with a crossing, extended by 1 for this month, runs, and resets next period", async () => {
    const run = setup({ ceiling: 10, budget: 5, start: utc(2026, 11, 3, 9) });
    const warmUp = await run.propose("Avery Lane at the kitchen counter, warm light", 1.2, 4);
    assert.equal(warmUp.estimate.kind, "quoted");
    const spent = await run.submit(warmUp);
    assert.deepEqual(spent.results.map((result) => result.outcome), ["completed", "completed", "completed", "completed"]);
    assert.equal(spent.warning, 80);
    run.setTime(utc(2026, 11, 20, 12));
    assert.equal(currentSpendPolicy(run.deps).spentUsd, 4.8);

    const proposal = await run.propose("Avery Lane holding the Ridgeline 32 oz bottle", 0.5);
    const blocked = await run.submit(proposal);
    assert.equal(blocked.results.length, 1);
    assert.equal(blocked.results[0].outcome, "blocked");
    const crossing = blocked.results[0].budget!;
    assert.equal(crossing.spentUsd, 4.8);
    assert.equal(crossing.remainingUsd, 0.2);
    assert.equal(crossing.costUsd, 0.5);
    assert.equal(crossing.extendable, true);
    assert.match(blocked.results[0].message!, /\$0\.50.*\$0\.20/);
    assert.equal(run.store.jobs.listByProject(run.project.id).length, 4, "nothing was admitted");

    const extended = addBudgetExtension(run.deps, { id: randomUUID(), periodKey: crossing.periodKey, amountUsd: 1 });
    assert.equal(extended.created, true);
    assert.equal(extended.policy.effectiveLimitUsd, 6);
    assert.equal(extended.policy.limitUsd, 5);

    const ran = await run.submit(proposal);
    assert.equal(ran.results[0].outcome, "completed");
    const after = currentSpendPolicy(run.deps);
    assert.equal(after.spentUsd, 5.3);
    assert.equal(after.remainingUsd, 0.7);

    run.setTime(utc(2026, 12, 1, 0, 0));
    const next = currentSpendPolicy(run.deps);
    assert.equal(next.period.key, "2026-12-01");
    assert.equal(next.limitUsd, 5);
    assert.equal(next.extensionUsd, 0, "the extension was for November only");
    assert.equal(next.effectiveLimitUsd, 5);
    assert.equal(next.spentUsd, 0);
    assert.equal(next.warning, 0);
  });

  test("an extension cannot raise the effective limit above GENERATION_ALLOWANCE_USD", async () => {
    const run = setup({ ceiling: 5.5, budget: 5, start: utc(2026, 11, 20) });
    const periodKey = currentSpendPolicy(run.deps).period.key;
    assert.throws(() => addBudgetExtension(run.deps, { id: randomUUID(), periodKey, amountUsd: 1 }), (error) => /At most \$0\.50/.test(toFailure(error).message));
    addBudgetExtension(run.deps, { id: randomUUID(), periodKey, amountUsd: 0.5 });
    assert.equal(currentSpendPolicy(run.deps).effectiveLimitUsd, 5.5);
    run.setCeiling(5.2);
    assert.equal(currentSpendPolicy(run.deps).effectiveLimitUsd, 5.2, "lowering the ceiling later still caps the extended limit");
    const big = await run.propose("Avery Lane in a car interior", 5.3);
    const blocked = await run.submit(big);
    assert.equal(blocked.results[0].outcome, "blocked");
    assert.equal(blocked.results[0].budget!.extendable, false);
  });

  test("a zero operator ceiling blocks every paid run whatever the budget or extension; free runs still go", async () => {
    const run = setup({ ceiling: 0, budget: 5, start: utc(2026, 11, 20) });
    const periodKey = currentSpendPolicy(run.deps).period.key;
    assert.throws(() => addBudgetExtension(run.deps, { id: randomUUID(), periodKey, amountUsd: 1 }), (error) => toFailure(error).code === "invalid");
    const paid = await run.submit(await run.propose("Avery Lane on a gym bench", 0.1));
    assert.equal(paid.results[0].outcome, "blocked");
    assert.equal(paid.results[0].message, PAID_GENERATION_OFF);
    assert.equal(paid.results[0].budget, null, "nothing to extend");
    const free = await run.submit(await run.propose("Ridgeline bottle on a counter", 0));
    assert.equal(free.results[0].outcome, "completed");
  });

  test("a later reset day starts a new budget period but not a new ceiling month", async () => {
    const run = setup({ ceiling: 6, budget: 5, start: utc(2026, 11, 3) });
    await run.submit(await run.propose("Avery Lane by a window", 4.5));
    run.setTime(utc(2026, 11, 20));
    run.store.workspace.update({ budgetResetDay: 15 }, utc(2026, 11, 20));
    const current = currentSpendPolicy(run.deps);
    assert.equal(current.period.key, "2026-11-15");
    assert.equal(current.spentUsd, 0, "the November 3 run is before this period");
    assert.equal(current.ceilingSpentUsd, 4.5, "but inside the ceiling's calendar month");
    assert.equal(current.remainingUsd, 1.5);
    const blocked = await run.submit(await run.propose("Avery Lane laughing", 2));
    assert.equal(blocked.results[0].outcome, "blocked");
    assert.equal(blocked.results[0].budget!.extendable, false);
  });

  test("a proposal whose estimate was lowered on the way back is still gated on the live price", async () => {
    const run = setup({ ceiling: 10, budget: 1, start: utc(2026, 11, 20) });
    const proposal = await run.propose("Avery Lane, close-up", 2);
    const tampered = { ...proposal, estimate: { ...proposal.estimate, usd: 0.01, credits: 2.1 } };
    const blocked = await run.submit(tampered);
    assert.equal(blocked.results[0].outcome, "blocked");
    assert.equal(blocked.results[0].budget!.costUsd, 2, "the crossing uses the executor's own estimate");
    assert.equal(run.store.jobs.listByProject(run.project.id).length, 0);
  });

  test("the whole-proposal check prices on the server: a raised client estimate does not block what fits", async () => {
    const run = setup({ ceiling: 10, budget: 1, start: utc(2026, 11, 20) });
    const proposal = await run.propose("Avery Lane, wide shot", 0.4, 2);
    const inflated = { ...proposal, estimate: { ...proposal.estimate, usd: 9, credits: 1890 } };
    const ran = await run.submit(inflated);
    assert.deepEqual(ran.results.map((result) => result.outcome), ["completed", "completed"]);
    assert.equal(currentSpendPolicy(run.deps).spentUsd, 0.8);
  });

  test("a block after some candidates already ran reports them, not just the block", async () => {
    const run = setup({ ceiling: 10, budget: 5, start: utc(2026, 11, 20) });
    const one = await run.propose("Avery Lane at the gym bench", 2, 1);
    assert.equal((await run.submit(one)).results[0].outcome, "completed");
    const more = await run.submit({ ...one, count: 3 });
    assert.deepEqual(more.results.map((result) => result.outcome), ["existing", "blocked"]);
    const [existing, blocked] = more.results;
    assert.equal(existing.job?.status, "completed");
    assert.equal(existing.assetIds.length, 1);
    assert.equal(blocked.budget!.costUsd, 4, "two new candidates at the executor's price");
    assert.equal(blocked.budget!.remainingUsd, 3);
    assert.equal(run.store.jobs.listByProject(run.project.id).length, 1);
  });

  test("no tool can raise the budget: extending is a person's click on a route", () => {
    const names = [...TOOLS, ...INTERNAL_TOOLS].map((tool) => tool.name);
    assert.ok(!names.some((name) => /budget|allowance|extend|ceiling/.test(name)), names.join(", "));
    assert.ok(AGENT_TOOLS.every((tool) => tool.name !== "submit_proposal"));
  });

  test("a repeated extension id adds once", () => {
    const run = setup({ ceiling: 10, budget: 5, start: utc(2026, 11, 20) });
    const request = { id: randomUUID(), periodKey: "2026-11-01", amountUsd: 1 };
    assert.equal(addBudgetExtension(run.deps, request).created, true);
    assert.equal(addBudgetExtension(run.deps, request).created, false);
    assert.equal(currentSpendPolicy(run.deps).extensionUsd, 1);
  });
});
