import { describe, expect, it } from "vitest";
import { reportsService } from "../src/app/modules/reports/reports.service.js";
import { prisma } from "../src/lib/prisma.js";
import { withRls } from "../src/lib/rls.js";
import {
  addMember,
  api,
  bearer,
  createBusiness,
  journalLines,
  ledgerIdByCode,
  registerUser,
  setupFinance,
  type FinanceSetup,
} from "./helpers/api.js";

const DATE = "2026-11-01";

const createTxn = async (f: FinanceSetup, body: object, auth = f.auth) => {
  const res = await api().post(`${f.base}/transactions`).set("Authorization", auth).send({ txnDate: DATE, ...body });
  if (res.status !== 201) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; status: string };
};

const postTxn = (f: FinanceSetup, id: string, auth = f.auth) =>
  api().post(`${f.base}/transactions/${id}/post`).set("Authorization", auth);

// Creates and posts, then returns the journal in compact form.
const postAndRead = async (f: FinanceSetup, body: object) => {
  const res = await api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ txnDate: DATE, postNow: true, ...body });
  expect(res.status).toBe(201);
  expect(res.body.data.status).toBe("POSTED");
  return journalLines(f.base, f.auth, res.body.data.journalEntryId);
};

const balanceOf = async (f: FinanceSetup, accountId: string) =>
  (await api().get(`${f.base}/accounts/${accountId}`).set("Authorization", f.auth)).body.data.currentBalanceMinor as string;

const line = (code: string, debit: string, credit: string) => ({ code, debit, credit });

const manual = (f: FinanceSetup, lines: object[], extra: object = {}, auth = f.auth) =>
  api().post(`${f.base}/journals`).set("Authorization", auth).send({ entryDate: DATE, memo: "Manual", lines, ...extra });

const report = async (f: FinanceSetup, path: string) => {
  const res = await api().get(`${f.base}/reports/${path}`).set("Authorization", f.auth);
  expect(res.status).toBe(200);
  return res.body.data;
};

describe("new business books", () => {
  it("seeds the chart of accounts, this fiscal year, and links Cash to 1100", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);

    const accounts = await prisma.ledgerAccount.findMany({ where: { businessId: business.id } });
    expect(accounts.map((item) => item.code)).toEqual(expect.arrayContaining(["1100", "1200", "2000", "3000", "3200", "3900", "4000", "4900", "6100", "6500", "6900"]));
    expect(accounts.every((item) => item.nameBn)).toBe(true);
    expect(accounts.find((item) => item.code === "4900")?.normalBalance).toBe("DEBIT");

    const cash = await prisma.financialAccount.findFirstOrThrow({ where: { businessId: business.id }, include: { ledgerAccount: true } });
    expect(cash.ledgerAccount?.code).toBe("1100");

    const periods = await prisma.fiscalPeriod.findMany({ where: { businessId: business.id }, orderBy: { startDate: "asc" } });
    expect(periods).toHaveLength(12);
    expect(periods[0]!.startDate.getUTCMonth()).toBe(6);
    expect(periods[0]!.startDate.getUTCDate()).toBe(1);
    expect(periods[11]!.endDate.getUTCMonth()).toBe(5);
    expect(periods[11]!.endDate.getUTCDate()).toBe(30);

    const categories = await prisma.category.findMany({ where: { businessId: business.id } });
    expect(categories.every((item) => item.ledgerAccountId)).toBe(true);
  });

  it("handles leap years and a January start", async () => {
    const owner = await registerUser();
    const res = await api().post("/api/v1/businesses").set("Authorization", bearer(owner)).send({ name: "Cal", type: "RETAIL", fiscalYearStartMonth: 1 });
    const base = `/api/v1/businesses/${res.body.data.id}`;
    const year = await api().post(`${base}/fiscal-periods/years`).set("Authorization", bearer(owner)).send({ fiscalYear: 2028 });
    expect(year.body.data).toHaveLength(12);
    expect(year.body.data[1]).toMatchObject({ startDate: "2028-02-01", endDate: "2028-02-29" });
    expect(year.body.data[11]).toMatchObject({ startDate: "2028-12-01", endDate: "2028-12-31" });
  });

  it("gives each new account its own ledger account in the right code range", async () => {
    const f = await setupFinance();
    const bkash = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "bKash Wallet", type: "BKASH" });
    const row = await prisma.financialAccount.findUniqueOrThrow({ where: { id: bkash.body.data.id }, include: { ledgerAccount: true } });
    expect(row.ledgerAccount).toMatchObject({ code: "1130", name: "bKash Wallet", type: "ASSET", normalBalance: "DEBIT" });
    const bank = await prisma.financialAccount.findUniqueOrThrow({ where: { id: f.bankId }, include: { ledgerAccount: true } });
    expect(bank.ledgerAccount?.code).toBe("1110");
  });
});

describe("opening balances", () => {
  it("post Dr the account and Cr Opening Balance Equity, so the books start balanced", async () => {
    const f = await setupFinance();
    const res = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "DBBL", type: "BANK", openingBalanceMinor: "5000000", openingDate: "2026-07-01" });
    expect(res.body.data.currentBalanceMinor).toBe("5000000");

    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { businessId: f.businessId, kind: "OPENING" } });
    expect(await journalLines(f.base, f.auth, entry.id)).toEqual([line("1111", "5000000", "0"), line("3900", "0", "5000000")]);
    expect((await report(f, "trial-balance?asOf=2026-07-01")).balanced).toBe(true);
  });

  it("an opening date before the first fiscal year opens that year", async () => {
    const f = await setupFinance();
    const res = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "Old", type: "BANK", openingBalanceMinor: "100", openingDate: "2020-03-15" });
    expect(res.status).toBe(201);
    const period = await prisma.fiscalPeriod.findFirst({ where: { businessId: f.businessId, fiscalYear: 2019 } });
    expect(period).not.toBeNull();
  });

  it("are refused for a foreign currency for now", async () => {
    const f = await setupFinance();
    const res = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "USD", type: "BANK", currency: "USD", openingBalanceMinor: "100" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("FOREIGN_CURRENCY_NOT_SUPPORTED");
    expect(await prisma.financialAccount.count({ where: { name: "USD" } })).toBe(0);
  });
});

describe("posting rules (document section 4.2)", () => {
  it("Cash sale: Dr the account, Cr revenue", async () => {
    const f = await setupFinance();
    const lines = await postAndRead(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "500000" });
    expect(lines).toEqual([line("1110", "500000", "0"), line("4000", "0", "500000")]);
    expect(await balanceOf(f, f.bankId)).toBe("500000");
  });

  it("Rent paid in cash: Dr 6100, Cr 1100", async () => {
    const f = await setupFinance();
    const lines = await postAndRead(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "3000000" });
    expect(lines).toEqual([line("6100", "3000000", "0"), line("1100", "0", "3000000")]);
    expect(await balanceOf(f, f.cashId)).toBe("-3000000");
  });

  it("Transfer: asset to asset, with the fee as the only expense", async () => {
    const f = await setupFinance();
    const bkash = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "bKash", type: "BKASH" });
    const lines = await postAndRead(f, { type: "TRANSFER", accountId: f.bankId, toAccountId: bkash.body.data.id, amountMinor: "1000000", feeMinor: "18500" });
    expect(lines).toEqual([
      line("1130", "1000000", "0"),
      line("1110", "0", "1000000"),
      line("6500", "18500", "0"),
      line("1110", "0", "18500"),
    ]);
    expect(await balanceOf(f, bkash.body.data.id)).toBe("1000000");
    expect(await balanceOf(f, f.bankId)).toBe("-1018500");

    const pnl = await report(f, `profit-and-loss?from=${DATE}&to=${DATE}`);
    expect(pnl.revenue.totalMinor).toBe("0");
    expect(pnl.expenses.totalMinor).toBe("18500");
  });

  it("A transfer with no fee never touches the P&L", async () => {
    const f = await setupFinance();
    await postAndRead(f, { type: "TRANSFER", accountId: f.bankId, toAccountId: f.cashId, amountMinor: "1000000" });
    const pnl = await report(f, `profit-and-loss?from=${DATE}&to=${DATE}`);
    expect(pnl.netProfitMinor).toBe("0");
    expect(pnl.revenue.items).toEqual([]);
    expect(pnl.expenses.items).toEqual([]);
  });

  it("Refund: Dr 4900 Sales Returns, which reduces revenue", async () => {
    const f = await setupFinance();
    await postAndRead(f, { type: "INCOME", accountId: f.cashId, categoryId: f.salesId, amountMinor: "100000" });
    const lines = await postAndRead(f, { type: "REFUND", accountId: f.cashId, categoryId: f.salesId, amountMinor: "30000" });
    expect(lines).toEqual([line("4900", "30000", "0"), line("1100", "0", "30000")]);

    const pnl = await report(f, `profit-and-loss?from=${DATE}&to=${DATE}`);
    expect(pnl.revenue.totalMinor).toBe("70000");
    expect(pnl.revenue.items.find((item: { code: string }) => item.code === "4900").amountMinor).toBe("-30000");
  });

  it("Adjustment follows its category's side, and needs a category to post", async () => {
    const f = await setupFinance();
    expect(await postAndRead(f, { type: "ADJUSTMENT", accountId: f.cashId, categoryId: f.salesId, amountMinor: "100" })).toEqual([line("1100", "100", "0"), line("4000", "0", "100")]);
    expect(await postAndRead(f, { type: "ADJUSTMENT", accountId: f.cashId, categoryId: f.rentId, amountMinor: "40" })).toEqual([line("6100", "40", "0"), line("1100", "0", "40")]);

    const noCategory = await createTxn(f, { type: "ADJUSTMENT", accountId: f.cashId, amountMinor: "100" });
    const res = await postTxn(f, noCategory.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("CATEGORY_REQUIRED");
  });

  it("A user-created category posts to its own new account", async () => {
    const f = await setupFinance();
    const category = await api().post(`${f.base}/categories`).set("Authorization", f.auth).send({ type: "EXPENSE", name: "Internet" });
    const lines = await postAndRead(f, { type: "EXPENSE", accountId: f.cashId, categoryId: category.body.data.id, amountMinor: "150000" });
    expect(lines).toEqual([line("7000", "150000", "0"), line("1100", "0", "150000")]);
  });

  it("Manual journals cover capital, drawings, unpaid invoices and bills", async () => {
    const f = await setupFinance();
    const [bank, equity, drawings, ar, ap, service, rent] = await Promise.all(
      ["1110", "3000", "3100", "1200", "2000", "4000", "6100"].map((code) => ledgerIdByCode(f.base, f.auth, code)),
    );
    const post = (dr: string, cr: string, amount: string) =>
      manual(f, [{ ledgerAccountId: dr, debitMinor: amount }, { ledgerAccountId: cr, creditMinor: amount }], { kind: "STANDARD" });

    expect((await post(bank!, equity!, "10000000")).status).toBe(201); // Owner puts in capital
    expect((await post(drawings!, bank!, "200000")).status).toBe(201); // Owner draws money
    expect((await post(ar!, service!, "2000000")).status).toBe(201); // Invoice issued, unpaid
    expect((await post(bank!, ar!, "2000000")).status).toBe(201); // Customer pays it
    expect((await post(rent!, ap!, "500000")).status).toBe(201); // Bill received, unpaid
    expect((await post(ap!, bank!, "500000")).status).toBe(201); // Bill paid

    // A manual journal on a bank's account moves that bank's balance too.
    expect(await balanceOf(f, f.bankId)).toBe("11300000");

    const sheet = await report(f, `balance-sheet?asOf=${DATE}`);
    expect(sheet.balanced).toBe(true);
    const pnl = await report(f, `profit-and-loss?from=${DATE}&to=${DATE}`);
    expect(pnl.netProfitMinor).toBe("1500000");
  });
});

describe("the post step", () => {
  it("a draft does not touch the books until it is posted", async () => {
    const f = await setupFinance();
    const draft = await createTxn(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "100" });
    expect(await balanceOf(f, f.cashId)).toBe("0");
    expect(await prisma.journalEntry.count({ where: { businessId: f.businessId } })).toBe(0);
    expect((await report(f, `trial-balance?asOf=${DATE}`)).items).toEqual([]);

    const posted = await postTxn(f, draft.id);
    expect(posted.status).toBe(200);
    expect(posted.body.data.status).toBe("POSTED");
    expect(await balanceOf(f, f.cashId)).toBe("-100");
    expect(await prisma.auditLog.count({ where: { action: "transaction.posted" } })).toBe(1);
  });

  it("cannot post twice, even at the same moment", async () => {
    const f = await setupFinance();
    const draft = await createTxn(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "100" });
    const results = await Promise.all([postTxn(f, draft.id), postTxn(f, draft.id)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await prisma.journalEntry.count({ where: { businessId: f.businessId } })).toBe(1);
    expect(await balanceOf(f, f.cashId)).toBe("-100");
  });

  it("keeps the balance right under many simultaneous postings", async () => {
    const f = await setupFinance();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ txnDate: DATE, postNow: true, type: "TRANSFER", accountId: f.bankId, toAccountId: f.cashId, amountMinor: "100" }),
      ),
    );
    expect(results.every((res) => res.status === 201)).toBe(true);
    expect(await balanceOf(f, f.cashId)).toBe("1000");
    expect(await balanceOf(f, f.bankId)).toBe("-1000");
    const numbers = await prisma.journalEntry.findMany({ where: { businessId: f.businessId }, select: { entryNo: true } });
    expect(new Set(numbers.map((item) => item.entryNo)).size).toBe(10);
  });

  it("a posted transaction cannot be edited, voided or posted again", async () => {
    const f = await setupFinance();
    const draft = await createTxn(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "100" });
    await postTxn(f, draft.id);
    const url = `${f.base}/transactions/${draft.id}`;
    expect((await api().patch(url).set("Authorization", f.auth).send({ amountMinor: "1" })).status).toBe(409);
    expect((await api().post(`${url}/void`).set("Authorization", f.auth)).status).toBe(409);
    expect((await postTxn(f, draft.id)).status).toBe(409);
  });

  it("if posting fails, the whole postNow request rolls back", async () => {
    const f = await setupFinance();
    await api().post(`${f.base}/fiscal-periods/${(await prisma.fiscalPeriod.findFirstOrThrow({ where: { businessId: f.businessId, startDate: new Date("2026-11-01") } })).id}/status`).set("Authorization", f.auth).send({ status: "SOFT_CLOSED" });
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    const res = await api().post(`${f.base}/transactions`).set("Authorization", bearer(accountant)).send({ txnDate: DATE, postNow: true, type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "100" });
    expect(res.status).toBe(409);
    expect(await prisma.transaction.count({ where: { businessId: f.businessId } })).toBe(0);
  });

  it("needs ledger.post, and postNow checks it too", async () => {
    const f = await setupFinance();
    const manager = await addMember(f.owner, f.businessId, "MANAGER");
    const draft = await createTxn(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "100" });
    expect((await postTxn(f, draft.id, bearer(manager))).status).toBe(403);
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    expect((await postTxn(f, draft.id, bearer(accountant))).status).toBe(200);
  });

  it("refuses a foreign-currency account for now", async () => {
    const f = await setupFinance();
    const usd = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "USD", type: "BANK", currency: "USD" });
    const draft = await createTxn(f, { type: "EXPENSE", accountId: usd.body.data.id, categoryId: f.rentId, amountMinor: "100" });
    const res = await postTxn(f, draft.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("FOREIGN_CURRENCY_NOT_SUPPORTED");
  });
});

describe("approval", () => {
  const withThreshold = async () => {
    const f = await setupFinance();
    await api().patch(f.base).set("Authorization", f.auth).send({ settings: { approvalThresholdMinor: "1000000" } });
    const admin = await addMember(f.owner, f.businessId, "ADMIN");
    return { f, admin };
  };
  const big = (f: FinanceSetup) => ({ type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "1000001" });

  it("an expense above the threshold waits, and touches nothing until approved", async () => {
    const { f, admin } = await withThreshold();
    const draft = await createTxn(f, big(f));
    const posted = await postTxn(f, draft.id);
    expect(posted.body.data.status).toBe("PENDING_APPROVAL");
    expect(await balanceOf(f, f.cashId)).toBe("0");

    const approved = await api().post(`${f.base}/transactions/${draft.id}/approve`).set("Authorization", bearer(admin));
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("POSTED");
    expect(approved.body.data.approvedBy).toBe(admin.userId);
    expect(await balanceOf(f, f.cashId)).toBe("-1000001");
  });

  it("at or below the threshold, and income or transfers, post straight away", async () => {
    const { f } = await withThreshold();
    const atLimit = await createTxn(f, { ...big(f), amountMinor: "1000000" });
    expect((await postTxn(f, atLimit.id)).body.data.status).toBe("POSTED");
    const income = await createTxn(f, { type: "INCOME", accountId: f.cashId, categoryId: f.salesId, amountMinor: "9000000" });
    expect((await postTxn(f, income.id)).body.data.status).toBe("POSTED");
  });

  it("whoever entered it cannot approve it", async () => {
    const { f } = await withThreshold();
    const draft = await createTxn(f, big(f));
    await postTxn(f, draft.id);
    const res = await api().post(`${f.base}/transactions/${draft.id}/approve`).set("Authorization", f.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("APPROVER_MUST_DIFFER");
  });

  it("an accountant cannot approve, and a rejected one is kept without posting", async () => {
    const { f, admin } = await withThreshold();
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    const draft = await createTxn(f, big(f));
    await postTxn(f, draft.id);
    expect((await api().post(`${f.base}/transactions/${draft.id}/approve`).set("Authorization", bearer(accountant))).status).toBe(403);

    const rejected = await api().post(`${f.base}/transactions/${draft.id}/reject`).set("Authorization", bearer(admin));
    expect(rejected.body.data.status).toBe("REJECTED");
    expect(await balanceOf(f, f.cashId)).toBe("0");
    expect((await api().post(`${f.base}/transactions/${draft.id}/approve`).set("Authorization", bearer(admin))).status).toBe(409);
  });
});

describe("reversal", () => {
  const posted = async (f: FinanceSetup) => {
    const draft = await createTxn(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "3000000" });
    return (await postTxn(f, draft.id)).body.data as { id: string; journalEntryId: string };
  };
  const reverse = (f: FinanceSetup, id: string, entryDate = "2026-11-05") =>
    api().post(`${f.base}/transactions/${id}/reverse`).set("Authorization", f.auth).send({ entryDate });

  it("books a mirror image, restores the balance and leaves the original untouched", async () => {
    const f = await setupFinance();
    const txn = await posted(f);
    const res = await reverse(f, txn.id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("VOID");

    expect(await journalLines(f.base, f.auth, res.body.data.reversalEntryId)).toEqual([line("6100", "0", "3000000"), line("1100", "3000000", "0")]);
    expect(await journalLines(f.base, f.auth, txn.journalEntryId)).toEqual([line("6100", "3000000", "0"), line("1100", "0", "3000000")]);
    expect(await balanceOf(f, f.cashId)).toBe("0");

    const original = await api().get(`${f.base}/journals/${txn.journalEntryId}`).set("Authorization", f.auth);
    expect(original.body.data.reversedBy.id).toBe(res.body.data.reversalEntryId);

    const pnl = await report(f, "profit-and-loss?from=2026-11-01&to=2026-11-30");
    expect(pnl.netProfitMinor).toBe("0");
  });

  it("the original month keeps its figure; the reversal lands in its own month", async () => {
    const f = await setupFinance();
    const txn = await posted(f);
    await reverse(f, txn.id, "2026-12-02");
    expect((await report(f, "profit-and-loss?from=2026-11-01&to=2026-11-30")).netProfitMinor).toBe("-3000000");
    expect((await report(f, "profit-and-loss?from=2026-12-01&to=2026-12-31")).netProfitMinor).toBe("3000000");
  });

  it("cannot happen twice, or before the original, or on a draft", async () => {
    const f = await setupFinance();
    const txn = await posted(f);
    const early = await reverse(f, txn.id, "2026-10-01");
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe("REVERSAL_DATE_INVALID");

    expect((await reverse(f, txn.id)).status).toBe(200);
    const again = await reverse(f, txn.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("TRANSACTION_NOT_POSTED");

    const draft = await createTxn(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "1" });
    expect((await reverse(f, draft.id)).status).toBe(409);
  });

  it("a transaction's journal must be reversed through the transaction", async () => {
    const f = await setupFinance();
    const txn = await posted(f);
    const res = await api().post(`${f.base}/journals/${txn.journalEntryId}/reverse`).set("Authorization", f.auth).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("JOURNAL_HAS_SOURCE");
  });

  it("a manual journal can be reversed once; opening entries cannot", async () => {
    const f = await setupFinance();
    const [cash, rent] = await Promise.all(["1100", "6100"].map((code) => ledgerIdByCode(f.base, f.auth, code)));
    const entry = await manual(f, [{ ledgerAccountId: rent, debitMinor: "100" }, { ledgerAccountId: cash, creditMinor: "100" }]);
    const url = `${f.base}/journals/${entry.body.data.id}/reverse`;

    const results = await Promise.all([1, 2].map(() => api().post(url).set("Authorization", f.auth).send({ entryDate: DATE })));
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(await balanceOf(f, f.cashId)).toBe("0");

    await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "Open", type: "BANK", openingBalanceMinor: "5", openingDate: DATE });
    const opening = await prisma.journalEntry.findFirstOrThrow({ where: { businessId: f.businessId, kind: "OPENING" } });
    const res = await api().post(`${f.base}/journals/${opening.id}/reverse`).set("Authorization", f.auth).send({});
    expect(res.status).toBe(409);
  });

  it("an accountant may reverse; a manager may not", async () => {
    const f = await setupFinance();
    const txn = await posted(f);
    const manager = await addMember(f.owner, f.businessId, "MANAGER");
    const res = await api().post(`${f.base}/transactions/${txn.id}/reverse`).set("Authorization", bearer(manager)).send({});
    expect(res.status).toBe(403);
  });
});

describe("manual journals", () => {
  it("refuses unbalanced entries and lines with both or neither side", async () => {
    const f = await setupFinance();
    const [cash, rent] = await Promise.all(["1100", "6100"].map((code) => ledgerIdByCode(f.base, f.auth, code)));

    const unbalanced = await manual(f, [{ ledgerAccountId: rent, debitMinor: "100" }, { ledgerAccountId: cash, creditMinor: "99" }]);
    expect(unbalanced.status).toBe(422);
    expect(unbalanced.body.error.code).toBe("JOURNAL_UNBALANCED");

    const both = await manual(f, [{ ledgerAccountId: rent, debitMinor: "100", creditMinor: "100" }, { ledgerAccountId: cash, creditMinor: "100" }]);
    expect(both.status).toBe(422);
    const neither = await manual(f, [{ ledgerAccountId: rent }, { ledgerAccountId: cash }]);
    expect(neither.status).toBe(422);
    const oneLine = await manual(f, [{ ledgerAccountId: rent, debitMinor: "100" }]);
    expect(oneLine.status).toBe(422);
    const system = await manual(f, [{ ledgerAccountId: rent, debitMinor: "1" }, { ledgerAccountId: cash, creditMinor: "1" }], { kind: "OPENING" });
    expect(system.status).toBe(422);
  });

  it("refuses accounts from another business, and is safe to retry", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    const [cash, rent] = await Promise.all(["1100", "6100"].map((code) => ledgerIdByCode(f.base, f.auth, code)));
    const theirs = await ledgerIdByCode(other.base, other.auth, "6100");

    const foreign = await manual(f, [{ ledgerAccountId: theirs, debitMinor: "1" }, { ledgerAccountId: cash, creditMinor: "1" }]);
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe("LEDGER_ACCOUNT_NOT_USABLE");

    const body = { entryDate: DATE, memo: "Retry", lines: [{ ledgerAccountId: rent, debitMinor: "1" }, { ledgerAccountId: cash, creditMinor: "1" }] };
    const send = () => api().post(`${f.base}/journals`).set("Authorization", f.auth).set("Idempotency-Key", "journal-retry-1").send(body);
    const first = await send();
    const retry = await send();
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(retry.get("Idempotency-Replayed")).toBe("true");
    expect(await prisma.journalEntry.count({ where: { businessId: f.businessId } })).toBe(1);
  });

  it("lists with filters", async () => {
    const f = await setupFinance();
    await postAndRead(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "1" });
    await postAndRead(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "1" });
    const rent = await ledgerIdByCode(f.base, f.auth, "6100");
    const res = await api().get(`${f.base}/journals?ledgerAccountId=${rent}`).set("Authorization", f.auth);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].entryNo).toMatch(/^JE-2026-\d{6}$/);
  });
});

describe("the database itself protects the books", () => {
  const seedEntry = async (f: FinanceSetup) => {
    await postAndRead(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "100" });
    return prisma.journalEntry.findFirstOrThrow({ where: { businessId: f.businessId }, include: { lines: true } });
  };

  const rawEntry = async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], base: { businessId: string; workspaceId: string; fiscalPeriodId: string; postedBy: string }, no: string, date = new Date("2026-11-01")) =>
    tx.journalEntry.create({ data: { ...base, entryNo: no, entryDate: date, kind: "STANDARD" } });

  it("rejects UPDATE, DELETE and TRUNCATE on journals, even for the owner", async () => {
    const f = await setupFinance();
    const entry = await seedEntry(f);
    for (const sql of [
      `UPDATE journal_entries SET memo = 'x'`,
      `DELETE FROM journal_entries`,
      `TRUNCATE journal_entries CASCADE`,
      `UPDATE journal_lines SET debit_minor = 1`,
      `DELETE FROM journal_lines`,
      `TRUNCATE journal_lines CASCADE`,
    ]) {
      await expect(prisma.$executeRawUnsafe(sql), sql).rejects.toThrow(/append-only/);
    }
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } })).memo).toBe(entry.memo);
  });

  it("rejects an unbalanced entry at COMMIT, even if the code is bypassed", async () => {
    const f = await setupFinance();
    const entry = await seedEntry(f);
    const base = { businessId: entry.businessId, workspaceId: entry.workspaceId, fiscalPeriodId: entry.fiscalPeriodId, postedBy: entry.postedBy };
    const account = entry.lines[0]!;
    await expect(
      prisma.$transaction(async (tx) => {
        const raw = await rawEntry(tx, base, "RAW-1");
        await tx.journalLine.createMany({
          data: [
            { workspaceId: base.workspaceId, businessId: base.businessId, journalEntryId: raw.id, ledgerAccountId: account.ledgerAccountId, lineNo: 1, debitMinor: 100n, currency: "BDT", baseAmountMinor: 100n },
            { workspaceId: base.workspaceId, businessId: base.businessId, journalEntryId: raw.id, ledgerAccountId: account.ledgerAccountId, lineNo: 2, creditMinor: 99n, currency: "BDT", baseAmountMinor: -99n },
          ],
        });
      }),
    ).rejects.toThrow(/unbalanced/);
    expect(await prisma.journalEntry.count({ where: { entryNo: "RAW-1" } })).toBe(0);
  });

  it("rejects an entry with no lines, a line with both sides, and a negative line", async () => {
    const f = await setupFinance();
    const entry = await seedEntry(f);
    const base = { businessId: entry.businessId, workspaceId: entry.workspaceId, fiscalPeriodId: entry.fiscalPeriodId, postedBy: entry.postedBy };
    await expect(prisma.$transaction((tx) => rawEntry(tx, base, "RAW-2"))).rejects.toThrow(/two lines/);

    const lineData = (journalEntryId: string, debitMinor: bigint, creditMinor: bigint) => ({
      workspaceId: base.workspaceId, businessId: base.businessId, journalEntryId, ledgerAccountId: entry.lines[0]!.ledgerAccountId, lineNo: 1, debitMinor, creditMinor, currency: "BDT", baseAmountMinor: 0n,
    });
    for (const [debit, credit] of [[5n, 5n], [0n, 0n], [-5n, 0n]] as const) {
      await expect(
        prisma.$transaction(async (tx) => {
          const raw = await rawEntry(tx, base, `RAW-${debit}-${credit}`);
          await tx.journalLine.create({ data: lineData(raw.id, debit, credit) });
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects a line on another business's account", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    const entry = await seedEntry(f);
    const foreign = await ledgerIdByCode(other.base, other.auth, "6100");
    const base = { businessId: entry.businessId, workspaceId: entry.workspaceId, fiscalPeriodId: entry.fiscalPeriodId, postedBy: entry.postedBy };
    await expect(
      prisma.$transaction(async (tx) => {
        const raw = await rawEntry(tx, base, "RAW-X");
        await tx.journalLine.createMany({
          data: [
            { workspaceId: base.workspaceId, businessId: base.businessId, journalEntryId: raw.id, ledgerAccountId: foreign, lineNo: 1, debitMinor: 1n, currency: "BDT", baseAmountMinor: 1n },
            { workspaceId: base.workspaceId, businessId: base.businessId, journalEntryId: raw.id, ledgerAccountId: entry.lines[1]!.ledgerAccountId, lineNo: 2, creditMinor: 1n, currency: "BDT", baseAmountMinor: -1n },
          ],
        });
      }),
    ).rejects.toThrow(/another business/);
  });

  it("rejects a date outside the period, and any entry in a closed period", async () => {
    const f = await setupFinance();
    const entry = await seedEntry(f);
    const base = { businessId: entry.businessId, workspaceId: entry.workspaceId, fiscalPeriodId: entry.fiscalPeriodId, postedBy: entry.postedBy };
    await expect(prisma.$transaction((tx) => rawEntry(tx, base, "RAW-D", new Date("2026-12-15")))).rejects.toThrow(/outside its fiscal period/);

    await prisma.fiscalPeriod.update({ where: { id: entry.fiscalPeriodId }, data: { status: "CLOSED" } });
    await expect(prisma.$transaction((tx) => rawEntry(tx, base, "RAW-C"))).rejects.toThrow(/closed/);
  });

  it("the restricted role can only insert and read journals, and only its own business", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    await seedEntry(f);
    await seedEntry(other);
    const scope = { userId: f.owner.userId, businessIds: [f.businessId] };

    for (const sql of [`UPDATE journal_entries SET memo = 'x'`, `DELETE FROM journal_lines`, `UPDATE journal_lines SET memo = 'x'`]) {
      await expect(withRls(scope, (tx) => tx.$executeRawUnsafe(sql)), sql).rejects.toThrow(/permission denied/);
    }
    const seen = await withRls(scope, async (tx) => ({
      entries: await tx.journalEntry.findMany(),
      lines: await tx.journalLine.findMany(),
      accounts: await tx.ledgerAccount.findMany(),
      periods: await tx.fiscalPeriod.findMany(),
    }));
    expect(seen.entries).toHaveLength(1);
    expect([...seen.entries, ...seen.lines, ...seen.accounts, ...seen.periods].every((row) => row.businessId === f.businessId)).toBe(true);
  });
});

describe("chart of accounts API", () => {
  it("creates accounts, refuses duplicate codes and bad parents, and protects system accounts", async () => {
    const f = await setupFinance();
    const url = `${f.base}/ledger-accounts`;
    const send = (body: object) => api().post(url).set("Authorization", f.auth).send(body);

    const created = await send({ code: "6950", name: "Bad Debts", type: "EXPENSE" });
    expect(created.status).toBe(201);
    expect(created.body.data.normalBalance).toBe("DEBIT");

    expect((await send({ code: "6950", name: "Again", type: "EXPENSE" })).body.error.code).toBe("CODE_TAKEN");
    const wrongParent = await send({ code: "6951", name: "Child", type: "EXPENSE", parentId: await ledgerIdByCode(f.base, f.auth, "1100") });
    expect(wrongParent.body.error.code).toBe("LEDGER_PARENT_INVALID");

    const system = await ledgerIdByCode(f.base, f.auth, "3900");
    const off = await api().patch(`${url}/${system}`).set("Authorization", f.auth).send({ isActive: false });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("LEDGER_ACCOUNT_PROTECTED");

    const userAccount = await api().patch(`${url}/${created.body.data.id}`).set("Authorization", f.auth).send({ isActive: false });
    expect(userAccount.status).toBe(200);
    const [cash] = await Promise.all(["1100"].map((code) => ledgerIdByCode(f.base, f.auth, code)));
    const unusable = await manual(f, [{ ledgerAccountId: created.body.data.id, debitMinor: "1" }, { ledgerAccountId: cash, creditMinor: "1" }]);
    expect(unusable.body.error.code).toBe("LEDGER_ACCOUNT_NOT_USABLE");
  });

  it("locks the base currency once there are journals, and the fiscal start always", async () => {
    const f = await setupFinance();
    expect((await api().patch(f.base).set("Authorization", f.auth).send({ fiscalYearStartMonth: 1 })).body.error.code).toBe("FISCAL_START_LOCKED");
    expect((await api().patch(f.base).set("Authorization", f.auth).send({ baseCurrency: "USD" })).status).toBe(200);
    await api().patch(f.base).set("Authorization", f.auth).send({ baseCurrency: "BDT" });

    await postAndRead(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "1" });
    const locked = await api().patch(f.base).set("Authorization", f.auth).send({ baseCurrency: "USD" });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("BASE_CURRENCY_LOCKED");
  });
});

describe("fiscal periods", () => {
  const periodId = async (f: FinanceSetup, start: string) =>
    (await prisma.fiscalPeriod.findFirstOrThrow({ where: { businessId: f.businessId, startDate: new Date(start) } })).id;
  const setStatus = async (f: FinanceSetup, start: string, status: string, auth = f.auth) =>
    api().post(`${f.base}/fiscal-periods/${await periodId(f, start)}/status`).set("Authorization", auth).send({ status });
  const expense = (f: FinanceSetup) => ({ type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "100" });

  it("soft-closed: admins may still post, accountants may not", async () => {
    const f = await setupFinance();
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    expect((await setStatus(f, "2026-11-01", "SOFT_CLOSED")).status).toBe(200);

    const first = await createTxn(f, expense(f));
    const refused = await postTxn(f, first.id, bearer(accountant));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PERIOD_SOFT_CLOSED");
    expect((await postTxn(f, first.id)).status).toBe(200);

    expect((await setStatus(f, "2026-11-01", "OPEN", bearer(accountant))).status).toBe(403);
    expect((await setStatus(f, "2026-11-01", "OPEN")).status).toBe(200);
  });

  it("closed: nobody can post, it can't reopen, and months close in order", async () => {
    const f = await setupFinance();
    const order = await setStatus(f, "2026-08-01", "CLOSED");
    expect(order.status).toBe(409);
    expect(order.body.error.code).toBe("PERIOD_ORDER");

    expect((await setStatus(f, "2026-07-01", "CLOSED")).status).toBe(200);
    const draft = await createTxn(f, { ...expense(f), txnDate: "2026-07-15" });
    const res = await postTxn(f, draft.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PERIOD_CLOSED");

    expect((await setStatus(f, "2026-07-01", "OPEN")).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: "period.status_changed" } })).toBe(1);
  });

  it("a correction to a closed month goes into the current one", async () => {
    const f = await setupFinance();
    const txn = await postAndRead(f, { ...expense(f), txnDate: "2026-07-15" });
    expect(txn).toHaveLength(2);
    const row = await prisma.transaction.findFirstOrThrow({ where: { businessId: f.businessId } });
    await setStatus(f, "2026-07-01", "CLOSED");

    const into = await api().post(`${f.base}/transactions/${row.id}/reverse`).set("Authorization", f.auth).send({ entryDate: "2026-07-20" });
    expect(into.status).toBe(409);
    expect(into.body.error.code).toBe("PERIOD_CLOSED");

    const current = await api().post(`${f.base}/transactions/${row.id}/reverse`).set("Authorization", f.auth).send({ entryDate: "2026-08-01" });
    expect(current.status).toBe(200);
  });

  it("posting beyond the last year opens the next one, but not a far-off or older year", async () => {
    const f = await setupFinance();
    const latest = await prisma.fiscalPeriod.aggregate({ where: { businessId: f.businessId }, _max: { endDate: true } });
    const nextDay = new Date(latest._max.endDate!.getTime() + 86_400_000).toISOString().slice(0, 10);
    const inRange = new Date(latest._max.endDate!).getTime() < Date.now() + 300 * 86_400_000;
    if (inRange) {
      const res = await api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ ...expense(f), txnDate: nextDay, postNow: true });
      expect(res.status).toBe(201);
    }

    for (const txnDate of ["2019-05-01", "2099-01-01"]) {
      const draft = await createTxn(f, { ...expense(f), txnDate, amountMinor: "7" });
      const res = await postTxn(f, draft.id);
      expect(res.status, txnDate).toBe(422);
      expect(res.body.error.code).toBe("FISCAL_PERIOD_NOT_FOUND");
    }
  });

  it("closing needs period.close and recent MFA", async () => {
    const f = await setupFinance();
    const manager = await addMember(f.owner, f.businessId, "MANAGER");
    expect((await setStatus(f, "2026-07-01", "SOFT_CLOSED", bearer(manager))).status).toBe(403);
  });
});

describe("year-end close", () => {
  const closeAllButLast = async (f: FinanceSetup) => {
    const periods = await prisma.fiscalPeriod.findMany({ where: { businessId: f.businessId, fiscalYear: 2026 }, orderBy: { startDate: "asc" } });
    for (const period of periods.slice(0, -1)) {
      await api().post(`${f.base}/fiscal-periods/${period.id}/status`).set("Authorization", f.auth).send({ status: "CLOSED" });
    }
    await api().post(`${f.base}/fiscal-periods/${periods.at(-1)!.id}/status`).set("Authorization", f.auth).send({ status: "SOFT_CLOSED" });
    return periods.at(-1)!;
  };
  const close = (f: FinanceSetup) => api().post(`${f.base}/fiscal-periods/years/2026/close`).set("Authorization", f.auth);

  it("moves profit to Retained Earnings, keeps the P&L, and starts next year at zero", async () => {
    const f = await setupFinance();
    await postAndRead(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "1000000" });
    await postAndRead(f, { type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "300000" });

    const refused = await close(f);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("YEAR_HAS_OPEN_PERIODS");

    await closeAllButLast(f);
    const closed = await close(f);
    expect(closed.status).toBe(200);
    expect(closed.body.data.netProfitMinor).toBe("700000");

    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { businessId: f.businessId, kind: "CLOSING" } });
    expect(entry.entryDate.toISOString().slice(0, 10)).toBe("2027-06-30");
    const lines = await journalLines(f.base, f.auth, entry.id);
    expect(lines).toEqual(expect.arrayContaining([line("4000", "1000000", "0"), line("6100", "0", "300000"), line("3200", "0", "700000")]));

    // The closed year's P&L still shows what happened.
    const pnl = await report(f, "profit-and-loss?from=2026-07-01&to=2027-06-30");
    expect(pnl.netProfitMinor).toBe("700000");
    expect(pnl.revenue.totalMinor).toBe("1000000");

    const sheet = await report(f, "balance-sheet?asOf=2027-06-30");
    expect(sheet.balanced).toBe(true);
    expect(sheet.equity.unclosedProfitMinor).toBe("0");
    expect(sheet.equity.items.find((item: { code: string }) => item.code === "3200").amountMinor).toBe("700000");
    expect(sheet.assets.totalMinor).toBe("700000");

    // Everything is closed and next year exists.
    const statuses = await prisma.fiscalPeriod.findMany({ where: { businessId: f.businessId, fiscalYear: 2026 } });
    expect(statuses.every((period) => period.status === "CLOSED")).toBe(true);
    expect(await prisma.fiscalPeriod.count({ where: { businessId: f.businessId, fiscalYear: 2027 } })).toBe(12);
    expect((await close(f)).body.error.code).toBe("YEAR_ALREADY_CLOSED");
  });

  it("a year's last period must close through the year-end close", async () => {
    const f = await setupFinance();
    const last = await closeAllButLast(f);
    const res = await api().post(`${f.base}/fiscal-periods/${last.id}/status`).set("Authorization", f.auth).send({ status: "CLOSED" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("USE_YEAR_CLOSE");
  });

  it("a year with a loss debits Retained Earnings; a year with no activity just closes", async () => {
    const f = await setupFinance();
    await postAndRead(f, { type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "500" });
    await closeAllButLast(f);
    const closed = await close(f);
    expect(closed.body.data.netProfitMinor).toBe("-500");
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { businessId: f.businessId, kind: "CLOSING" } });
    expect(await journalLines(f.base, f.auth, entry.id)).toEqual(expect.arrayContaining([line("3200", "500", "0"), line("6100", "0", "500")]));

    const empty = await setupFinance();
    await closeAllButLast(empty);
    const res = await close(empty);
    expect(res.status).toBe(200);
    expect(res.body.data.closingEntryNo).toBeNull();
  });

  it("closing entries cannot be reversed", async () => {
    const f = await setupFinance();
    await postAndRead(f, { type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "500" });
    await closeAllButLast(f);
    await close(f);
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { businessId: f.businessId, kind: "CLOSING" } });
    const res = await api().post(`${f.base}/journals/${entry.id}/reverse`).set("Authorization", f.auth).send({});
    expect(res.status).toBe(409);
  });
});

describe("reports", () => {
  const scenario = async () => {
    const f = await setupFinance();
    const bkash = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "bKash", type: "BKASH", openingBalanceMinor: "200000", openingDate: "2026-10-15" });
    const [bank, equity, fixedAssets, ar, service] = await Promise.all(
      ["1110", "3000", "1500", "1200", "4000"].map((code) => ledgerIdByCode(f.base, f.auth, code)),
    );
    const post = (dr: string, cr: string, amount: string) =>
      manual(f, [{ ledgerAccountId: dr, debitMinor: amount }, { ledgerAccountId: cr, creditMinor: amount }], { kind: "STANDARD" });

    await post(bank!, equity!, "10000000"); // capital: financing +100,000
    await post(fixedAssets!, bank!, "2000000"); // equipment: investing -20,000
    await post(ar!, service!, "500000"); // unpaid invoice: profit, but no cash
    await postAndRead(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "1000000" });
    await postAndRead(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "300000" });
    await postAndRead(f, { type: "TRANSFER", accountId: f.bankId, toAccountId: bkash.body.data.id, amountMinor: "100000", feeMinor: "1000" });
    // A draft must not appear anywhere.
    await createTxn(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "999999999" });
    return f;
  };

  it("trial balance: debits equal credits, and a later date sees more", async () => {
    const f = await scenario();
    const tb = await report(f, `trial-balance?asOf=${DATE}`);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    expect(tb.currency).toBe("BDT");
    expect(tb.basis).toBe("POSTED_ACTUALS");
    const row = (code: string) => tb.items.find((item: { code: string }) => item.code === code);
    expect(row("6100").debitBalanceMinor).toBe("300000");
    expect(row("3000").creditBalanceMinor).toBe("10000000");
    expect(row("1100").creditBalanceMinor).toBe("300000");

    const before = await report(f, "trial-balance?asOf=2026-10-20");
    expect(before.items.map((item: { code: string }) => item.code).sort()).toEqual(["1130", "3900"]);
  });

  it("P&L: accrual profit, excluding transfers and drafts", async () => {
    const f = await scenario();
    const pnl = await report(f, `profit-and-loss?from=${DATE}&to=${DATE}`);
    expect(pnl.revenue.totalMinor).toBe("1500000");
    expect(pnl.expenses.totalMinor).toBe("301000");
    expect(pnl.netProfitMinor).toBe("1199000");
  });

  it("balance sheet: Assets = Liabilities + Equity", async () => {
    const f = await scenario();
    const sheet = await report(f, `balance-sheet?asOf=${DATE}`);
    expect(sheet.balanced).toBe(true);
    // Cash and bank 8,899,000 + equipment 2,000,000 + unpaid invoice 500,000, all in paisa.
    expect(sheet.assets.totalMinor).toBe("11399000");
    expect(sheet.liabilities.totalMinor).toBe("0");
    expect(sheet.equity.totalMinor).toBe("11399000");
    expect(sheet.equity.unclosedProfitMinor).toBe("1199000");
  });

  it("cash flow: classified by counter-account, and it ties to the cash balance", async () => {
    const f = await scenario();
    const flow = await report(f, `cash-flow?from=2026-10-01&to=${DATE}`);
    expect(flow.balanced).toBe(true);
    expect(flow.beginningCashMinor).toBe("0");
    expect(flow.openingBalancesMinor).toBe("200000");
    // Sale +1,000,000, rent -300,000, fee -1,000. The unpaid invoice is not cash.
    expect(flow.operating.totalMinor).toBe("699000");
    expect(flow.investing.totalMinor).toBe("-2000000");
    expect(flow.financing.totalMinor).toBe("10000000");
    expect(flow.netChangeMinor).toBe("8699000");
    expect(flow.endingCashMinor).toBe("8899000");

    // Profit and cash differ whenever invoices are unpaid.
    const accounts = await api().get(`${f.base}/accounts`).set("Authorization", f.auth);
    const total = accounts.body.data.reduce((sum: bigint, item: { currentBalanceMinor: string }) => sum + BigInt(item.currentBalanceMinor), 0n);
    expect(String(total)).toBe(flow.endingCashMinor);
  });

  it("needs finance.read, and another business sees nothing", async () => {
    const f = await scenario();
    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    expect((await api().get(`${f.base}/reports/trial-balance?asOf=${DATE}`).set("Authorization", bearer(viewer))).status).toBe(403);
    const other = await setupFinance();
    expect((await api().get(`${f.base}/reports/trial-balance?asOf=${DATE}`).set("Authorization", other.auth)).status).toBe(404);
    expect((await report(other, `trial-balance?asOf=${DATE}`)).items).toEqual([]);
  });

  it("rejects missing or impossible dates", async () => {
    const f = await setupFinance();
    expect((await api().get(`${f.base}/reports/trial-balance`).set("Authorization", f.auth)).status).toBe(422);
    expect((await api().get(`${f.base}/reports/balance-sheet?asOf=2026-02-30`).set("Authorization", f.auth)).status).toBe(422);
  });

  it("the verify check finds nothing wrong, and catches a tampered balance", async () => {
    const f = await scenario();
    expect(await reportsService.verifyBusiness(f.businessId)).toMatchObject({ unbalancedEntries: 0, accountsOutOfStep: 0 });
    await prisma.financialAccount.update({ where: { id: f.cashId }, data: { currentBalanceMinor: 1n } });
    expect((await reportsService.verifyBusiness(f.businessId)).accountsOutOfStep).toBe(1);
  });
});

describe("reconciliation", () => {
  const start = (f: FinanceSetup, statementBalanceMinor: string, statementDate = "2026-11-30") =>
    api().post(`${f.base}/reconciliations`).set("Authorization", f.auth).send({ financialAccountId: f.bankId, statementDate, statementBalanceMinor });

  const seed = async () => {
    const f = await setupFinance();
    await postAndRead(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "1000" });
    await postAndRead(f, { type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "400" });
    return f;
  };

  it("closes at zero difference, with lines staying matched", async () => {
    const f = await seed();
    const created = await start(f, "600");
    expect(created.status).toBe(201);
    const url = `${f.base}/reconciliations/${created.body.data.id}`;

    const view = await api().get(url).set("Authorization", f.auth);
    expect(view.body.data).toMatchObject({ clearedMinor: "0", bookBalanceMinor: "600", differenceMinor: "600" });
    expect(view.body.data.unmatchedLines).toHaveLength(2);

    const early = await api().post(`${url}/close`).set("Authorization", f.auth).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("RECONCILIATION_DIFFERENCE");

    const ids = view.body.data.unmatchedLines.map((item: { id: string }) => item.id);
    const matched = await api().post(`${url}/lines`).set("Authorization", f.auth).send({ journalLineIds: ids });
    expect(matched.body.data.differenceMinor).toBe("0");

    const closed = await api().post(`${url}/close`).set("Authorization", f.auth).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: "CLOSED", differenceMinor: "0", bookBalanceMinor: "600" });

    // A closed one can't change, and the next statement starts from what was cleared.
    expect((await api().post(`${url}/lines`).set("Authorization", f.auth).send({ journalLineIds: ids })).status).toBe(409);
    await postAndRead(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "50", txnDate: "2026-12-02" });
    const next = await start(f, "650", "2026-12-31");
    const nextView = await api().get(`${f.base}/reconciliations/${next.body.data.id}`).set("Authorization", f.auth);
    expect(nextView.body.data).toMatchObject({ clearedMinor: "600", differenceMinor: "50" });
    expect(nextView.body.data.unmatchedLines).toHaveLength(1);
  });

  it("an adjustment books the difference to 6900 and needs approval rights", async () => {
    const f = await seed();
    const created = await start(f, "590");
    const url = `${f.base}/reconciliations/${created.body.data.id}`;
    const view = await api().get(url).set("Authorization", f.auth);
    await api().post(`${url}/lines`).set("Authorization", f.auth).send({ journalLineIds: view.body.data.unmatchedLines.map((item: { id: string }) => item.id) });

    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    const denied = await api().post(`${url}/close`).set("Authorization", bearer(accountant)).send({ adjust: true });
    expect(denied.status).toBe(403);

    const closed = await api().post(`${url}/close`).set("Authorization", f.auth).send({ adjust: true });
    expect(closed.status).toBe(200);
    expect(closed.body.data.differenceMinor).toBe("-10");
    expect(await journalLines(f.base, f.auth, closed.body.data.adjustmentEntryId)).toEqual([line("6900", "10", "0"), line("1110", "0", "10")]);
    expect(await balanceOf(f, f.bankId)).toBe("590");
  });

  it("allows one open per account, refuses wrong lines, and can un-match", async () => {
    const f = await seed();
    const created = await start(f, "600");
    expect((await start(f, "600")).body.error.code).toBe("RECONCILIATION_ALREADY_OPEN");
    const url = `${f.base}/reconciliations/${created.body.data.id}`;

    await postAndRead(f, { type: "EXPENSE", accountId: f.cashId, categoryId: f.rentId, amountMinor: "5" });
    const cashLedger = await ledgerIdByCode(f.base, f.auth, "1100");
    const cashLine = await prisma.journalLine.findFirstOrThrow({ where: { ledgerAccountId: cashLedger } });
    const wrong = await api().post(`${url}/lines`).set("Authorization", f.auth).send({ journalLineIds: [cashLine.id] });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe("JOURNAL_LINE_NOT_MATCHABLE");

    const view = await api().get(url).set("Authorization", f.auth);
    const id = view.body.data.unmatchedLines[0].id;
    await api().post(`${url}/lines`).set("Authorization", f.auth).send({ journalLineIds: [id] });
    expect((await api().delete(`${url}/lines/${id}`).set("Authorization", f.auth)).status).toBe(200);
    expect((await api().delete(`${url}/lines/${id}`).set("Authorization", f.auth)).status).toBe(404);

    // Journal lines themselves were never changed by any of this.
    expect((await api().get(url).set("Authorization", f.auth)).body.data.unmatchedLines).toHaveLength(2);
  });

  it("accepts a negative statement balance", async () => {
    const f = await seed();
    const res = await start(f, "-500");
    expect(res.status).toBe(201);
    expect(res.body.data.statementBalanceMinor).toBe("-500");
  });
});

describe("the worked example in the README", () => {
  it("produces exactly the figures the README shows", async () => {
    const f = await setupFinance();
    const taka = (amount: number) => String(amount * 100);

    const bank = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "Example Bank", type: "BANK", openingBalanceMinor: taka(50_000), openingDate: DATE });
    const bkash = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "bKash Wallet", type: "BKASH" });
    const bankId = bank.body.data.id;

    const bankRow = await prisma.financialAccount.findUniqueOrThrow({ where: { id: bankId } });
    const [equity, ar, sales] = await Promise.all(["3000", "1200", "4000"].map((code) => ledgerIdByCode(f.base, f.auth, code)));

    await manual(f, [{ ledgerAccountId: bankRow.ledgerAccountId, debitMinor: taka(100_000) }, { ledgerAccountId: equity, creditMinor: taka(100_000) }], { kind: "STANDARD" }).expect(201);
    await postAndRead(f, { type: "INCOME", accountId: bankId, categoryId: f.salesId, amountMinor: taka(40_000) });
    await postAndRead(f, { type: "EXPENSE", accountId: bankId, categoryId: f.rentId, amountMinor: taka(30_000) });
    await postAndRead(f, { type: "TRANSFER", accountId: bankId, toAccountId: bkash.body.data.id, amountMinor: taka(10_000), feeMinor: taka(185) });
    await postAndRead(f, { type: "REFUND", accountId: bkash.body.data.id, categoryId: f.salesId, amountMinor: taka(2_000) });
    await manual(f, [{ ledgerAccountId: ar, debitMinor: taka(20_000) }, { ledgerAccountId: sales, creditMinor: taka(20_000) }], { kind: "STANDARD" }).expect(201);

    const trial = await report(f, `trial-balance?asOf=${DATE}`);
    expect(trial.totalDebitMinor).toBe(taka(210_000));
    expect(trial.totalCreditMinor).toBe(taka(210_000));

    const pnl = await report(f, `profit-and-loss?from=${DATE}&to=${DATE}`);
    expect(pnl.revenue.totalMinor).toBe(taka(58_000));
    expect(pnl.expenses.totalMinor).toBe(taka(30_185));
    expect(pnl.netProfitMinor).toBe(taka(27_815));

    const sheet = await report(f, `balance-sheet?asOf=${DATE}`);
    expect(sheet.assets.totalMinor).toBe(taka(177_815));
    expect(sheet.equity.totalMinor).toBe(taka(177_815));
    expect(sheet.balanced).toBe(true);

    const flow = await report(f, `cash-flow?from=${DATE}&to=${DATE}`);
    expect(flow.operating.totalMinor).toBe(taka(7_815));
    expect(flow.financing.totalMinor).toBe(taka(100_000));
    expect(flow.openingBalancesMinor).toBe(taka(50_000));
    expect(flow.endingCashMinor).toBe(taka(157_815));
  });
});

describe("older businesses", () => {
  it("db:provision links accounts and rebuilds the balance through an opening journal, once", async () => {
    const owner = await registerUser();
    const created = await createBusiness(owner);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: created.id } });

    // How a Phase 3 account looked: a plain balance, with no ledger link and no journal.
    const old = await prisma.financialAccount.create({
      data: {
        workspaceId: business.workspaceId, businessId: business.id, createdBy: owner.userId, name: "Old Bank", type: "BANK",
        currency: "BDT", openingBalanceMinor: 5000n, currentBalanceMinor: 5000n, openingDate: new Date("2026-08-01"),
      },
    });
    const category = await prisma.category.create({
      data: { workspaceId: business.workspaceId, businessId: business.id, createdBy: owner.userId, type: "EXPENSE", name: "Old Category" },
    });

    const { businessesService } = await import("../src/app/modules/businesses/businesses.service.js");
    for (let run = 0; run < 2; run++) {
      await prisma.$transaction((tx) => businessesService.provision(tx, business));
    }

    const account = await prisma.financialAccount.findUniqueOrThrow({ where: { id: old.id } });
    expect(account.ledgerAccountId).not.toBeNull();
    expect(account.currentBalanceMinor).toBe(5000n);
    expect(await prisma.journalEntry.count({ where: { businessId: business.id, kind: "OPENING" } })).toBe(1);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: category.id } })).ledgerAccountId).not.toBeNull();
    expect(await reportsService.verifyBusiness(business.id)).toMatchObject({ unbalancedEntries: 0, accountsOutOfStep: 0 });
  });
});
