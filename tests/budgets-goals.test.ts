import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { addMember, api, bearer, runPendingEvents, setupFinance, type FinanceSetup } from "./helpers/api.js";

const post = async (f: FinanceSetup, body: object) => {
  const res = await api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ postNow: true, txnDate: "2026-11-05", ...body });
  if (res.status !== 201) throw new Error(`post failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const spendRent = (f: FinanceSetup, amountMinor: string) => post(f, { type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor });
const earn = (f: FinanceSetup, amountMinor: string) => post(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor });

const createBudget = async (f: FinanceSetup, overrides: object = {}) => {
  const res = await api().post(`${f.base}/budgets`).set("Authorization", f.auth).send({
    name: "November",
    startMonth: "2026-11",
    endMonth: "2026-11",
    lines: [{ categoryId: f.rentId, amountMinor: "1000" }],
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`budget failed: ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string };
};
const readBudget = async (f: FinanceSetup, id: string) => (await api().get(`${f.base}/budgets/${id}`).set("Authorization", f.auth)).body.data;

describe("budgets", () => {
  it("compares the budget with what the ledger actually shows", async () => {
    const f = await setupFinance();
    const budget = await createBudget(f);
    await spendRent(f, "250");
    // Outside the budget's months, so it doesn't count.
    await post(f, { type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "999", txnDate: "2026-10-05" });
    // A draft doesn't count either.
    await api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "999", txnDate: "2026-11-05" });

    const data = await readBudget(f, budget.id);
    expect(data).toMatchObject({ currency: "BDT", basis: "POSTED_ACTUALS", startMonth: "2026-11" });
    expect(data.lines[0]).toMatchObject({ amountMinor: "1000", actualMinor: "250", remainingMinor: "750", usedPercent: "25.00", level: "OK", alertPercent: 80 });
    expect(data.lines[0].category.name).toBe("Rent");
  });

  it("alerts at the threshold and at 100%, each exactly once", async () => {
    const f = await setupFinance();
    const budget = await createBudget(f);

    await spendRent(f, "790");
    await runPendingEvents();
    expect(await prisma.budgetAlert.count()).toBe(0);

    await spendRent(f, "10");
    await runPendingEvents();
    let data = await readBudget(f, budget.id);
    expect(data.lines[0].level).toBe("NEAR");
    expect(data.lines[0].alerts.map((alert: { percent: number }) => alert.percent)).toEqual([80]);

    await spendRent(f, "1");
    await runPendingEvents();
    expect(await prisma.budgetAlert.count()).toBe(1);

    await spendRent(f, "199");
    await runPendingEvents();
    data = await readBudget(f, budget.id);
    expect(data.lines[0].level).toBe("REACHED");
    expect(data.lines[0].alerts.map((alert: { percent: number }) => alert.percent)).toEqual([80, 100]);

    await spendRent(f, "1");
    await runPendingEvents();
    data = await readBudget(f, budget.id);
    expect(data.lines[0].level).toBe("OVER");
    expect(data.lines[0].remainingMinor).toBe("-1");
    expect(await prisma.budgetAlert.count()).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { type: "budget.threshold_reached" } })).toBe(2);
  });

  it("reversing an expense frees the budget again", async () => {
    const f = await setupFinance();
    const budget = await createBudget(f);
    const txn = await spendRent(f, "900");
    await api().post(`${f.base}/transactions/${txn.id}/reverse`).set("Authorization", f.auth).send({ entryDate: "2026-11-06" });
    expect((await readBudget(f, budget.id)).lines[0]).toMatchObject({ actualMinor: "0", level: "OK" });
  });

  it("tracks an income target through the credit side", async () => {
    const f = await setupFinance();
    const budget = await createBudget(f, { lines: [{ categoryId: f.salesId, amountMinor: "1000" }] });
    await earn(f, "400");
    expect((await readBudget(f, budget.id)).lines[0].actualMinor).toBe("400");
  });

  it("refuses two categories sharing one ledger account, and another business's category", async () => {
    const f = await setupFinance();
    const rent = await prisma.category.findUniqueOrThrow({ where: { id: f.rentId } });
    const twin = await api().post(`${f.base}/categories`).set("Authorization", f.auth).send({ type: "EXPENSE", name: "Office Rent", ledgerAccountId: rent.ledgerAccountId });

    const shared = await api().post(`${f.base}/budgets`).set("Authorization", f.auth).send({
      name: "Shared", startMonth: "2026-11", endMonth: "2026-11",
      lines: [{ categoryId: f.rentId, amountMinor: "1" }, { categoryId: twin.body.data.id, amountMinor: "1" }],
    });
    expect(shared.status).toBe(422);
    expect(shared.body.error.code).toBe("BUDGET_LINE_DUPLICATE");

    const other = await setupFinance();
    const foreign = await api().post(`${f.base}/budgets`).set("Authorization", f.auth).send({ name: "X", startMonth: "2026-11", endMonth: "2026-11", lines: [{ categoryId: other.rentId, amountMinor: "1" }] });
    expect(foreign.body.error.code).toBe("CATEGORY_NOT_USABLE");
  });

  it("validates months and amounts, archives, and changes a line", async () => {
    const f = await setupFinance();
    const backwards = await api().post(`${f.base}/budgets`).set("Authorization", f.auth).send({ name: "X", startMonth: "2026-12", endMonth: "2026-11", lines: [{ categoryId: f.rentId, amountMinor: "1" }] });
    expect(backwards.body.error.code).toBe("INVALID_MONTH_RANGE");
    const zero = await api().post(`${f.base}/budgets`).set("Authorization", f.auth).send({ name: "X", startMonth: "2026-11", endMonth: "2026-11", lines: [{ categoryId: f.rentId, amountMinor: "0" }] });
    expect(zero.status).toBe(422);

    const budget = await createBudget(f);
    const line = await api().post(`${f.base}/budgets/${budget.id}/lines`).set("Authorization", f.auth).send({ categoryId: f.rentId, amountMinor: "5000", alertPercent: 50 });
    expect(line.status).toBe(200);
    expect((await readBudget(f, budget.id)).lines).toHaveLength(1);
    expect((await readBudget(f, budget.id)).lines[0]).toMatchObject({ amountMinor: "5000", alertPercent: 50 });

    await api().patch(`${f.base}/budgets/${budget.id}`).set("Authorization", f.auth).send({ status: "ARCHIVED" });
    expect((await api().get(`${f.base}/budgets`).set("Authorization", f.auth)).body.data).toHaveLength(0);
    expect((await api().get(`${f.base}/budgets?includeArchived=true`).set("Authorization", f.auth)).body.data).toHaveLength(1);

    // An archived budget stops alerting.
    await spendRent(f, "4999");
    await runPendingEvents();
    expect(await prisma.budgetAlert.count()).toBe(0);
  });

  it("follows permissions and business isolation", async () => {
    const f = await setupFinance();
    const budget = await createBudget(f);
    const manager = await addMember(f.owner, f.businessId, "MANAGER");
    expect((await api().get(`${f.base}/budgets`).set("Authorization", bearer(manager))).status).toBe(403);

    const other = await setupFinance();
    expect((await api().get(`${other.base}/budgets/${budget.id}`).set("Authorization", other.auth)).status).toBe(404);
    expect((await api().get(`${f.base}/budgets/${budget.id}`).set("Authorization", other.auth)).status).toBe(404);
  });
});

describe("goals", () => {
  const createGoal = async (f: FinanceSetup, body: object) => {
    const res = await api().post(`${f.base}/goals`).set("Authorization", f.auth).send({ name: "Goal", startMonth: "2026-11", endMonth: "2026-12", ...body });
    if (res.status !== 201) throw new Error(`goal failed: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const readGoal = async (f: FinanceSetup, id: string) => (await api().get(`${f.base}/goals/${id}`).set("Authorization", f.auth)).body.data;

  it("tracks revenue and profit over its months, and becomes achieved", async () => {
    const f = await setupFinance();
    const revenue = await createGoal(f, { metric: "REVENUE", targetMinor: "1000" });
    const profit = await createGoal(f, { metric: "NET_PROFIT", targetMinor: "1000" });

    await earn(f, "1000");
    await spendRent(f, "400");
    await runPendingEvents();

    const achieved = await readGoal(f, revenue.id);
    expect(achieved).toMatchObject({ status: "ACHIEVED", currentMinor: "1000", progressPercent: "100.00", remainingMinor: "0" });
    expect(achieved.achievedAt).toBeTruthy();

    expect(await readGoal(f, profit.id)).toMatchObject({ status: "ACTIVE", currentMinor: "600", progressPercent: "60.00", remainingMinor: "400" });
    expect(await prisma.outboxEvent.count({ where: { type: "goal.achieved" } })).toBe(1);

    // Running the same events again changes nothing.
    await runPendingEvents();
    expect(await prisma.outboxEvent.count({ where: { type: "goal.achieved" } })).toBe(1);
  });

  it("a cash goal uses the balance, including earlier money", async () => {
    const f = await setupFinance();
    await post(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "700", txnDate: "2026-08-05" });
    const goal = await createGoal(f, { metric: "CASH_BALANCE", targetMinor: "1000" });
    expect(goal).toMatchObject({ currentMinor: "700", progressPercent: "70.00" });
  });

  it("can be cancelled, then no longer changes", async () => {
    const f = await setupFinance();
    const goal = await createGoal(f, { metric: "REVENUE", targetMinor: "100" });
    const url = `${f.base}/goals/${goal.id}`;
    expect((await api().patch(url).set("Authorization", f.auth).send({ targetMinor: "200" })).body.data.targetMinor).toBe("200");
    expect((await api().patch(url).set("Authorization", f.auth).send({ status: "CANCELLED" })).body.data.status).toBe("CANCELLED");

    await earn(f, "1000");
    await runPendingEvents();
    expect((await readGoal(f, goal.id)).status).toBe("CANCELLED");
    const again = await api().patch(url).set("Authorization", f.auth).send({ name: "New" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("GOAL_NOT_ACTIVE");
  });

  it("rejects a bad target, and lists by status", async () => {
    const f = await setupFinance();
    const bad = await api().post(`${f.base}/goals`).set("Authorization", f.auth).send({ name: "X", metric: "REVENUE", targetMinor: "0", startMonth: "2026-11", endMonth: "2026-12" });
    expect(bad.status).toBe(422);
    await createGoal(f, { metric: "REVENUE", targetMinor: "100" });
    expect((await api().get(`${f.base}/goals?status=ACTIVE`).set("Authorization", f.auth)).body.data).toHaveLength(1);
    expect((await api().get(`${f.base}/goals?status=ACHIEVED`).set("Authorization", f.auth)).body.data).toHaveLength(0);
  });
});
