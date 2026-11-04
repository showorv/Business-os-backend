import { describe, expect, it } from "vitest";
import { reportsService } from "../src/app/modules/reports/reports.service.js";
import { convertMinor, formatMoney, percentOf, toDecimalString } from "../src/app/utils/money.js";
import { prisma } from "../src/lib/prisma.js";
import { withRls } from "../src/lib/rls.js";
import { addMember, api, bearer, ledgerIdByCode, setupFinance, type FinanceSetup } from "./helpers/api.js";

const post = async (f: FinanceSetup, body: object) => {
  const res = await api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ postNow: true, ...body });
  if (res.status !== 201) throw new Error(`post failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const income = (f: FinanceSetup, amountMinor: string, txnDate: string, accountId = f.bankId) =>
  post(f, { type: "INCOME", accountId, categoryId: f.salesId, amountMinor, txnDate });
const expense = (f: FinanceSetup, amountMinor: string, txnDate: string, accountId = f.bankId) =>
  post(f, { type: "EXPENSE", accountId, categoryId: f.rentId, amountMinor, txnDate });

const dashboard = async (f: FinanceSetup, query: string) => {
  const res = await api().get(`${f.base}/analytics/dashboard?${query}`).set("Authorization", f.auth);
  expect(res.status).toBe(200);
  return res.body.data;
};

describe("monthly rollups", () => {
  it("stay in step with the ledger, by a trigger, with no worker involved", async () => {
    const f = await setupFinance();
    await income(f, "1000", "2026-11-05");
    await income(f, "500", "2026-11-20");
    await expense(f, "300", "2026-12-01");

    const rent = await ledgerIdByCode(f.base, f.auth, "6100");
    const sales = await ledgerIdByCode(f.base, f.auth, "4000");
    const rows = await prisma.ledgerMonthlyRollup.findMany({ where: { businessId: f.businessId } });
    const find = (id: string, month: string) => rows.find((row) => row.ledgerAccountId === id && row.month.toISOString().startsWith(month));

    expect(find(sales, "2026-11")).toMatchObject({ creditMinor: 1500n, debitMinor: 0n });
    expect(find(rent, "2026-12")).toMatchObject({ debitMinor: 300n, creditMinor: 0n });
    expect(await reportsService.verifyBusiness(f.businessId)).toMatchObject({ rollupsOutOfStep: 0 });
  });

  it("include reversals, and the verify check catches a tampered row", async () => {
    const f = await setupFinance();
    const txn = await expense(f, "300", "2026-11-05");
    await api().post(`${f.base}/transactions/${txn.id}/reverse`).set("Authorization", f.auth).send({ entryDate: "2026-11-06" });
    expect((await dashboard(f, "fromMonth=2026-11&toMonth=2026-11")).expensesMinor).toBe("0");

    expect(await reportsService.verifyBusiness(f.businessId)).toMatchObject({ rollupsOutOfStep: 0 });
    await prisma.ledgerMonthlyRollup.updateMany({ where: { businessId: f.businessId }, data: { debitMinor: { increment: 1n } } });
    expect((await reportsService.verifyBusiness(f.businessId)).rollupsOutOfStep).toBeGreaterThan(0);
  });

  it("do not deadlock when transfers run in opposite directions at the same moment", async () => {
    const f = await setupFinance();
    const transfer = (from: string, to: string) =>
      api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ postNow: true, type: "TRANSFER", accountId: from, toAccountId: to, amountMinor: "10", txnDate: "2026-11-05" });
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? transfer(f.cashId, f.bankId) : transfer(f.bankId, f.cashId))));
    expect(results.map((res) => res.status)).toEqual(Array(12).fill(201));
    expect(await reportsService.verifyBusiness(f.businessId)).toMatchObject({ rollupsOutOfStep: 0, accountsOutOfStep: 0 });
  });

  it("the restricted role can read them but never write them", async () => {
    const f = await setupFinance();
    await income(f, "1000", "2026-11-05");
    const scope = { userId: f.owner.userId, businessIds: [f.businessId] };
    await expect(withRls(scope, (tx) => tx.$executeRawUnsafe(`UPDATE ledger_monthly_rollups SET debit_minor = 1`))).rejects.toThrow(/permission denied/);
    await expect(withRls(scope, (tx) => tx.$executeRawUnsafe(`DELETE FROM ledger_monthly_rollups`))).rejects.toThrow(/permission denied/);

    const other = await setupFinance();
    await income(other, "9", "2026-11-05");
    const rows = await withRls(scope, (tx) => tx.ledgerMonthlyRollup.findMany());
    expect(rows.every((row) => row.businessId === f.businessId)).toBe(true);
  });
});

describe("dashboard", () => {
  it("matches the formal reports", async () => {
    const f = await setupFinance();
    await income(f, "1000000", "2026-11-05");
    await expense(f, "300000", "2026-11-06");
    await post(f, { type: "TRANSFER", accountId: f.bankId, toAccountId: f.cashId, amountMinor: "100000", feeMinor: "1000", txnDate: "2026-11-07" });
    // A draft must not appear.
    await api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "999", txnDate: "2026-11-08" });

    const data = await dashboard(f, "fromMonth=2026-11&toMonth=2026-11");
    expect(data).toMatchObject({
      currency: "BDT",
      basis: "POSTED_ACTUALS",
      asOf: "2026-11-30",
      revenueMinor: "1000000",
      expensesMinor: "301000",
      netProfitMinor: "699000",
      cashBalanceMinor: "699000",
    });

    const pnl = await api().get(`${f.base}/reports/profit-and-loss?from=2026-11-01&to=2026-11-30`).set("Authorization", f.auth);
    expect(data.netProfitMinor).toBe(pnl.body.data.netProfitMinor);
  });

  it("shows profit and cash separately, with receivables and payables", async () => {
    const f = await setupFinance();
    const [ar, sales, rent, ap] = await Promise.all(["1200", "4000", "6100", "2000"].map((code) => ledgerIdByCode(f.base, f.auth, code)));
    const journal = (dr: string, cr: string, amount: string) =>
      api().post(`${f.base}/journals`).set("Authorization", f.auth).send({ entryDate: "2026-11-05", memo: "x", kind: "STANDARD", lines: [{ ledgerAccountId: dr, debitMinor: amount }, { ledgerAccountId: cr, creditMinor: amount }] });
    await journal(ar!, sales!, "2000");
    await journal(rent!, ap!, "500");

    const data = await dashboard(f, "fromMonth=2026-11&toMonth=2026-11");
    expect(data).toMatchObject({ netProfitMinor: "1500", cashBalanceMinor: "0", receivableMinor: "2000", payableMinor: "500" });
  });

  it("fills empty months in the trend and ranks expenses", async () => {
    const f = await setupFinance();
    await income(f, "1000", "2026-08-15");
    await expense(f, "400", "2026-10-15");
    await post(f, { type: "EXPENSE", accountId: f.bankId, categoryId: (await prisma.category.findFirstOrThrow({ where: { businessId: f.businessId, name: "Marketing" } })).id, amountMinor: "100", txnDate: "2026-10-16" });

    const data = await dashboard(f, "fromMonth=2026-08&toMonth=2026-10");
    expect(data.trend.map((row: { month: string; netProfitMinor: string }) => [row.month, row.netProfitMinor])).toEqual([
      ["2026-08", "1000"],
      ["2026-09", "0"],
      ["2026-10", "-500"],
    ]);
    expect(data.topExpenses.map((row: { code: string; sharePercent: string }) => [row.code, row.sharePercent])).toEqual([
      ["6100", "80.00"],
      ["6300", "20.00"],
    ]);
  });

  it("balances add up all earlier months, not just the range", async () => {
    const f = await setupFinance();
    await income(f, "1000", "2026-08-15");
    const data = await dashboard(f, "fromMonth=2026-11&toMonth=2026-11");
    expect(data.revenueMinor).toBe("0");
    expect(data.cashBalanceMinor).toBe("1000");
  });

  it("uses this fiscal year by default, and refuses a bad range", async () => {
    const f = await setupFinance();
    const data = await dashboard(f, "");
    expect(data.fromMonth).toMatch(/^\d{4}-07$/);

    const bad = await api().get(`${f.base}/analytics/dashboard?fromMonth=2026-12&toMonth=2026-01`).set("Authorization", f.auth);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("INVALID_MONTH_RANGE");
    const badMonth = await api().get(`${f.base}/analytics/dashboard?fromMonth=2026-13`).set("Authorization", f.auth);
    expect(badMonth.status).toBe(422);
  });

  it("needs finance.read, and hides other businesses", async () => {
    const f = await setupFinance();
    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    expect((await api().get(`${f.base}/analytics/dashboard`).set("Authorization", bearer(viewer))).status).toBe(403);
    const other = await setupFinance();
    expect((await api().get(`${f.base}/analytics/dashboard`).set("Authorization", other.auth)).status).toBe(404);
  });
});

describe("year-end close and rollups", () => {
  it("keeps a closed year's months intact on the dashboard", async () => {
    const f = await setupFinance();
    await income(f, "1000", "2026-11-05");
    const periods = await prisma.fiscalPeriod.findMany({ where: { businessId: f.businessId, fiscalYear: 2026 }, orderBy: { startDate: "asc" } });
    for (const period of periods.slice(0, -1)) {
      await api().post(`${f.base}/fiscal-periods/${period.id}/status`).set("Authorization", f.auth).send({ status: "CLOSED" });
    }
    await api().post(`${f.base}/fiscal-periods/${periods.at(-1)!.id}/status`).set("Authorization", f.auth).send({ status: "SOFT_CLOSED" });
    expect((await api().post(`${f.base}/fiscal-periods/years/2026/close`).set("Authorization", f.auth)).status).toBe(200);

    const data = await dashboard(f, "fromMonth=2026-07&toMonth=2027-06");
    expect(data.revenueMinor).toBe("1000");
    expect(data.netProfitMinor).toBe("1000");
    expect(await reportsService.verifyBusiness(f.businessId)).toMatchObject({ rollupsOutOfStep: 0 });
  });
});

describe("comparison", () => {
  const compare = (f: FinanceSetup, metric: string, current: string, previous: string) =>
    api().get(`${f.base}/analytics/compare?metric=${metric}&fromMonth=${current}&toMonth=${current}&compareFromMonth=${previous}&compareToMonth=${previous}`).set("Authorization", f.auth);

  it("gives the change and the percentage", async () => {
    const f = await setupFinance();
    await income(f, "1000", "2026-10-05");
    await income(f, "1500", "2026-11-05");
    await expense(f, "200", "2026-11-06");

    const revenue = await compare(f, "REVENUE", "2026-11", "2026-10");
    expect(revenue.body.data).toMatchObject({ changeMinor: "500", changePercent: "50.00", current: { amountMinor: "1500" }, comparedTo: { amountMinor: "1000" } });
    const profit = await compare(f, "NET_PROFIT", "2026-11", "2026-10");
    expect(profit.body.data).toMatchObject({ changeMinor: "300", changePercent: "30.00" });
  });

  it("has no percentage against zero, and reads correctly coming out of a loss", async () => {
    const f = await setupFinance();
    await income(f, "1000", "2026-11-05");
    expect((await compare(f, "REVENUE", "2026-11", "2026-10")).body.data.changePercent).toBeNull();

    await expense(f, "100", "2026-09-05");
    await income(f, "50", "2026-10-05");
    const fromLoss = await compare(f, "NET_PROFIT", "2026-10", "2026-09");
    expect(fromLoss.body.data).toMatchObject({ changeMinor: "150", changePercent: "150.00" });
  });
});

describe("money helpers", () => {
  const lakh = { digitStyle: "latin", grouping: "lakh" } as const;

  it("groups in lakh and crore, or western, and never loses precision", () => {
    expect(formatMoney(125000000n, "BDT", lakh)).toBe("৳12,50,000.00");
    expect(formatMoney(1234567890123n, "BDT", lakh)).toBe("৳12,34,56,78,901.23");
    expect(formatMoney(125000000n, "BDT", { digitStyle: "latin", grouping: "western" })).toBe("৳1,250,000.00");
    expect(formatMoney(5n, "BDT", lakh)).toBe("৳0.05");
    expect(formatMoney(-18500n, "BDT", lakh)).toBe("-৳185.00");
    expect(formatMoney(999999999999999999n, "BDT", lakh)).toBe("৳9,99,99,99,99,99,99,999.99");
    expect(formatMoney(1500n, "JPY", lakh)).toBe("JPY 1,500");
  });

  it("writes Bangla digits", () => {
    expect(formatMoney(125000000n, "BDT", { digitStyle: "bangla", grouping: "lakh" })).toBe("৳১২,৫০,০০০.০০");
  });

  it("plain decimals for spreadsheets", () => {
    expect(toDecimalString(3000050n, "BDT")).toBe("30000.50");
    expect(toDecimalString(-5n, "BDT")).toBe("-0.05");
    expect(toDecimalString(1500n, "JPY")).toBe("1500");
  });

  it("converts with rounding, between currencies of different precision", () => {
    expect(convertMinor(10000n, "120.000000", "USD", "BDT")).toBe(1200000n);
    expect(convertMinor(1200000n, "120.000000", "USD", "BDT", true)).toBe(10000n);
    expect(convertMinor(100n, "0.335000", "USD", "BDT")).toBe(34n);
    expect(convertMinor(-100n, "0.335000", "USD", "BDT")).toBe(-34n);
    // JPY has no decimals: $1.00 at 150 is ¥150, not ¥15000.
    expect(convertMinor(100n, "150.000000", "USD", "JPY")).toBe(150n);
    expect(convertMinor(100n, "1.000000", "BDT", "BDT")).toBe(100n);
  });

  it("percentages", () => {
    expect(percentOf(1n, 3n)).toBe("33.33");
    expect(percentOf(2n, 3n)).toBe("66.67");
    expect(percentOf(-1n, 8n)).toBe("-12.50");
    expect(percentOf(5n, 0n)).toBeNull();
  });
});
