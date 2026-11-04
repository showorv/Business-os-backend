import { describe, expect, it, vi } from "vitest";
import { statementLinesService } from "../src/app/modules/statement-lines/statement-lines.service.js";
import { prisma } from "../src/lib/prisma.js";
import { addMember, api, bearer, journalLines, runPendingEvents, setupFinance, type FinanceSetup } from "./helpers/api.js";
import { HEADER, importStatement, linesOf } from "./helpers/statements.js";

vi.mock("../src/lib/mailer.js", () => ({ emailEnabled: () => true, sendEmail: vi.fn(async () => {}) }));

const post = (f: FinanceSetup, path: string, body: object = {}) => api().post(`${f.base}${path}`).set("Authorization", f.auth).send(body);

const expense = (f: FinanceSetup, extra: object = {}) =>
  post(f, "/transactions", { postNow: true, type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "300000", txnDate: "2026-11-02", ...extra });

const income = (f: FinanceSetup, extra: object = {}) =>
  post(f, "/transactions", { postNow: true, type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "500000", txnDate: "2026-11-01", ...extra });

const rentLine = (ref = "", date = "02/11/2026", details = "Payment") => `${HEADER}\n${date},${details},${ref},3000.00,,\n`;

const onlyLine = async (f: FinanceSetup) => (await linesOf(f))[0]!;

describe("automatic matching", () => {
  it("the same reference matches, even with several of the same amount", async () => {
    const f = await setupFinance();
    await expense(f, { referenceNo: "CHQ-77" });
    await expense(f, { referenceNo: "CHQ-78" });
    await importStatement(f, rentLine("CHQ-78"));

    const line = await onlyLine(f);
    expect(line).toMatchObject({ status: "MATCHED", matchedBy: "REFERENCE" });
    const [link] = await prisma.statementLineLink.findMany({ where: { statementLineId: line.id }, include: { transaction: true } });
    expect(link?.transaction?.referenceNo).toBe("CHQ-78");
  });

  it("a single entry for that amount on the same day matches", async () => {
    const f = await setupFinance();
    await expense(f);
    await importStatement(f, rentLine());
    expect(await onlyLine(f)).toMatchObject({ status: "MATCHED", matchedBy: "AMOUNT_DATE" });
  });

  it("a nearby date also needs the words to agree", async () => {
    const f = await setupFinance();
    await expense(f, { description: "Office rent November" });
    await importStatement(f, rentLine("", "04/11/2026", "RENT PAID"));
    expect(await onlyLine(f)).toMatchObject({ status: "MATCHED", matchedBy: "AMOUNT_DATE" });
  });

  it("a nearby date with unrelated words waits for a person", async () => {
    const f = await setupFinance();
    await expense(f, { description: "Office rent" });
    await importStatement(f, rentLine("", "04/11/2026", "Unknown"));
    expect((await onlyLine(f)).status).toBe("UNMATCHED");
  });

  it("two possibilities wait for a person, rather than guessing", async () => {
    const f = await setupFinance();
    await expense(f);
    await expense(f, { description: "Second" });
    await importStatement(f, rentLine());
    expect((await onlyLine(f)).status).toBe("UNMATCHED");
  });

  it("doesn't match the wrong side, account, amount, or a date too far away", async () => {
    const f = await setupFinance();
    await income(f, { amountMinor: "300000", txnDate: "2026-11-02" });
    await expense(f, { accountId: f.cashId });
    await expense(f, { amountMinor: "300001" });
    await expense(f, { txnDate: "2026-11-20" });
    await importStatement(f, rentLine());
    expect((await onlyLine(f)).status).toBe("UNMATCHED");
  });

  it("one journal line can settle only one statement line", async () => {
    const f = await setupFinance();
    await expense(f);
    await importStatement(f, `${HEADER}\n02/11/2026,A,,3000.00,,\n02/11/2026,B,,3000.00,,\n`);
    const statuses = (await linesOf(f)).map((line) => line.status).sort();
    expect(statuses).toEqual(["MATCHED", "UNMATCHED"]);
  });

  it("the database itself refuses a journal line settling two statement lines", async () => {
    const f = await setupFinance();
    await expense(f);
    await importStatement(f, `${HEADER}\n02/11/2026,A,,3000.00,,\n02/11/2026,B,,3000.00,,\n`);
    const lines = await linesOf(f);
    const matched = lines.find((line) => line.status === "MATCHED")!;
    const open = lines.find((line) => line.status === "UNMATCHED")!;
    const { journalLineId } = await prisma.statementLineLink.findFirstOrThrow({ where: { statementLineId: matched.id } });

    await expect(prisma.statementLineLink.create({ data: { businessId: f.businessId, statementLineId: open.id, journalLineId } })).rejects.toThrow();
  });

  it("doesn't match a reversed transaction or its reversal", async () => {
    const f = await setupFinance();
    const { body } = await expense(f);
    expect((await post(f, `/transactions/${body.data.id}/reverse`)).status).toBe(200);
    await importStatement(f, rentLine());
    expect((await onlyLine(f)).status).toBe("UNMATCHED");
  });

  it("matching a line later picks up what was entered after importing", async () => {
    const f = await setupFinance();
    await importStatement(f, rentLine());
    await expense(f);
    expect((await post(f, "/statement-lines/run-matcher")).body.data).toMatchObject({ matched: 1, needsReview: 0 });
    expect((await onlyLine(f)).status).toBe("MATCHED");
  });

  it("matching doesn't change the books", async () => {
    const f = await setupFinance();
    await expense(f);
    const before = await prisma.journalEntry.count({ where: { businessId: f.businessId } });
    await importStatement(f, rentLine());
    expect(await prisma.journalEntry.count({ where: { businessId: f.businessId } })).toBe(before);
  });
});

describe("rules", () => {
  const FACEBOOK = `${HEADER}\n03/11/2026,FACEBOOK ADS NOV,FB-1,1500.00,,\n`;
  const rule = (f: FinanceSetup, extra: object = {}) => post(f, "/statement-rules", { name: "Ads", containsText: "facebook", direction: "OUT", categoryId: f.rentId, ...extra });

  it("creates a draft by default, ignoring case", async () => {
    const f = await setupFinance();
    expect((await rule(f)).status).toBe(201);
    await importStatement(f, FACEBOOK);
    const line = await onlyLine(f);
    expect(line).toMatchObject({ status: "AWAITING_POSTING", matchedBy: "RULE" });

    const [transaction] = await prisma.transaction.findMany({ where: { businessId: f.businessId, source: "IMPORT" } });
    expect(transaction).toMatchObject({ status: "DRAFT", amountMinor: 150000n, referenceNo: "FB-1", categoryId: f.rentId });
  });

  it("autoPost posts it, with a balanced journal, and the line is settled", async () => {
    const f = await setupFinance();
    await rule(f, { autoPost: true });
    await importStatement(f, FACEBOOK);
    expect(await onlyLine(f)).toMatchObject({ status: "MATCHED", matchedBy: "RULE" });

    const [transaction] = await prisma.transaction.findMany({ where: { businessId: f.businessId, source: "IMPORT" } });
    const lines = await journalLines(f.base, f.auth, transaction!.journalEntryId!);
    expect(lines).toContainEqual({ code: "6100", debit: "150000", credit: "0" });
  });

  it("an existing entry beats a rule, so nothing is recorded twice", async () => {
    const f = await setupFinance();
    await rule(f, { autoPost: true });
    await expense(f, { amountMinor: "150000", txnDate: "2026-11-03" });
    await importStatement(f, FACEBOOK);
    expect(await onlyLine(f)).toMatchObject({ status: "MATCHED", matchedBy: "AMOUNT_DATE" });
    expect(await prisma.transaction.count({ where: { businessId: f.businessId, source: "IMPORT" } })).toBe(0);
  });

  it("respects the direction, the limit, inactive rules and priority", async () => {
    const f = await setupFinance();
    const utilities = (await api().get(`${f.base}/categories`).set("Authorization", f.auth)).body.data.find((c: { name: string }) => c.name === "Utilities").id;
    await rule(f, { name: "Limited", maxAmountMinor: "100", priority: 1 });
    const off = await rule(f, { name: "Off", priority: 2 });
    await api().patch(`${f.base}/statement-rules/${off.body.data.id}`).set("Authorization", f.auth).send({ isActive: false });
    await rule(f, { name: "Winner", categoryId: utilities, priority: 3 });
    await rule(f, { name: "Later", priority: 4 });
    await importStatement(f, FACEBOOK);
    const [transaction] = await prisma.transaction.findMany({ where: { businessId: f.businessId, source: "IMPORT" } });
    expect(transaction?.categoryId).toBe(utilities);
  });

  it("a rule's category must fit its direction", async () => {
    const f = await setupFinance();
    const res = await rule(f, { categoryId: f.salesId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("RULE_CATEGORY_MISMATCH");
  });

  it("a closed period leaves the line for a person, and says why", async () => {
    const f = await setupFinance();
    await rule(f, { autoPost: true });
    await prisma.fiscalPeriod.updateMany({ where: { businessId: f.businessId, startDate: new Date("2026-11-01") }, data: { status: "CLOSED" } });
    const result = await importStatement(f, FACEBOOK);
    expect(result.status).toBe("COMPLETED");
    const line = await onlyLine(f);
    expect(line.status).toBe("UNMATCHED");
    expect(line.lastMatchError).toMatch(/PERIOD/);
    expect(await prisma.transaction.count({ where: { businessId: f.businessId, source: "IMPORT" } })).toBe(0);
  });

  it("someone who can't post can't make a rule that posts", async () => {
    const f = await setupFinance();
    const manager = await addMember(f.owner, f.businessId, "MANAGER");
    const res = await api().post(`${f.base}/statement-rules`).set("Authorization", bearer(manager)).send({ name: "x", containsText: "x", direction: "OUT", categoryId: f.rentId, autoPost: true });
    expect(res.status).toBe(403);
  });

  it("an amount above the approval limit still waits for approval", async () => {
    const f = await setupFinance();
    await api().patch(f.base).set("Authorization", f.auth).send({ settings: { approvalThresholdMinor: "1000" } });
    await rule(f, { autoPost: true });
    await importStatement(f, FACEBOOK);
    expect((await onlyLine(f)).status).toBe("AWAITING_POSTING");
    const [transaction] = await prisma.transaction.findMany({ where: { businessId: f.businessId, source: "IMPORT" } });
    expect(transaction?.status).toBe("PENDING_APPROVAL");
  });

  it("a user's text can't slow the server, because it isn't a pattern", async () => {
    const f = await setupFinance();
    await rule(f, { containsText: "(a+)+$" });
    await importStatement(f, `${HEADER}\n03/11/2026,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!,,1.00,,\n`);
    expect((await onlyLine(f)).status).toBe("UNMATCHED");
  });
});

describe("a fee shown on the statement", () => {
  const MAPPING_WITH_FEE = { dateColumn: "Date", dateFormat: "DD/MM/YYYY", descriptionColumn: "Details", debitColumn: "Debit", creditColumn: "Credit", feeColumn: "Fee" };
  const CASH_OUT = "Date,Details,Debit,Credit,Fee\n03/11/2026,Cash out,1018.50,,18.50\n";

  it("a transfer posts the fee to Bank Charges, and both account lines are linked", async () => {
    const f = await setupFinance();
    const wallet = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "bKash", type: "BKASH" });
    await importStatement(f, CASH_OUT, f.bankId, MAPPING_WITH_FEE);
    const line = await onlyLine(f);

    const res = await post(f, `/statement-lines/${line.id}/categorize`, { transferAccountId: wallet.body.data.id, postNow: true });
    expect(res.body.data.status).toBe("MATCHED");

    const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: res.body.data.transactionId } });
    expect(transaction).toMatchObject({ amountMinor: 100000n, feeMinor: 1850n });
    const lines = await journalLines(f.base, f.auth, transaction.journalEntryId!);
    expect(lines).toContainEqual(expect.objectContaining({ code: "6500", debit: "1850" }));

    // Together the two account lines equal what the statement says left the bank.
    const links = await prisma.statementLineLink.findMany({ where: { statementLineId: line.id }, include: { journalLine: true } });
    expect(links).toHaveLength(2);
    expect(links.reduce((sum, link) => sum + link.journalLine!.creditMinor, 0n)).toBe(101850n);
  });

  it("an expense puts the whole amount on its category", async () => {
    const f = await setupFinance();
    await post(f, "/statement-rules", { name: "Cash out", containsText: "cash out", direction: "OUT", categoryId: f.rentId, autoPost: true });
    await importStatement(f, CASH_OUT, f.bankId, MAPPING_WITH_FEE);
    expect(await onlyLine(f)).toMatchObject({ status: "MATCHED" });
    const [transaction] = await prisma.transaction.findMany({ where: { businessId: f.businessId, source: "IMPORT" } });
    expect(transaction).toMatchObject({ amountMinor: 101850n, feeMinor: 0n });
  });

  it("a draft transfer with a fee links both lines once it's posted", async () => {
    const f = await setupFinance();
    const wallet = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "bKash", type: "BKASH" });
    await importStatement(f, CASH_OUT, f.bankId, MAPPING_WITH_FEE);
    const line = await onlyLine(f);
    const res = await post(f, `/statement-lines/${line.id}/categorize`, { transferAccountId: wallet.body.data.id });
    expect(res.body.data.status).toBe("AWAITING_POSTING");

    await post(f, `/transactions/${res.body.data.transactionId}/post`);
    await runPendingEvents();
    expect((await onlyLine(f)).status).toBe("MATCHED");
    expect(await prisma.statementLineLink.count({ where: { statementLineId: line.id, journalLineId: { not: null } } })).toBe(2);
  });
});

describe("the review inbox", () => {
  const setupLine = async () => {
    const f = await setupFinance();
    await importStatement(f, rentLine("", "02/11/2026", "Unknown"));
    return { f, line: await onlyLine(f) };
  };

  it("shows counts, filters and suggestions", async () => {
    const { f, line } = await setupLine();
    await expense(f, { txnDate: "2026-11-09", description: "Nearby" });
    expect((await api().get(`${f.base}/statement-lines/summary`).set("Authorization", f.auth)).body.data).toMatchObject({ unmatched: 1, matched: 0 });
    expect(await linesOf(f, "&status=MATCHED")).toHaveLength(0);

    const detail = await api().get(`${f.base}/statement-lines/${line.id}`).set("Authorization", f.auth);
    expect(detail.body.data.suggestions).toHaveLength(1);
    expect(detail.body.data.suggestions[0]).toMatchObject({ entryDate: "2026-11-09", memo: "Nearby" });
  });

  it("match by hand, then undo", async () => {
    const { f, line } = await setupLine();
    const { body } = await expense(f, { txnDate: "2026-11-20" });
    const [journalLine] = await prisma.journalLine.findMany({ where: { journalEntryId: body.data.journalEntryId, creditMinor: 300000n } });

    const matched = await post(f, `/statement-lines/${line.id}/match`, { journalLineIds: [journalLine!.id] });
    expect(matched.status).toBe(200);
    expect(matched.body.data).toMatchObject({ status: "MATCHED", matchedBy: "MANUAL" });

    const undone = await post(f, `/statement-lines/${line.id}/unmatch`);
    expect(undone.body.data.status).toBe("UNMATCHED");
    expect((await post(f, `/statement-lines/${line.id}/match`, { journalLineIds: [journalLine!.id] })).status).toBe(200);
  });

  it("several entries can add up to one statement line, but must add up", async () => {
    const f = await setupFinance();
    await importStatement(f, `${HEADER}\n02/11/2026,Deposit,,,1000.00,\n`);
    const line = await onlyLine(f);
    const one = await income(f, { amountMinor: "60000", txnDate: "2026-11-02" });
    const two = await income(f, { amountMinor: "40000", txnDate: "2026-11-02" });
    const three = await income(f, { amountMinor: "1", txnDate: "2026-11-02" });
    const debitLine = async (entry: string) => (await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: entry, debitMinor: { gt: 0 } } })).id;
    const a = await debitLine(one.body.data.journalEntryId);
    const b = await debitLine(two.body.data.journalEntryId);
    const c = await debitLine(three.body.data.journalEntryId);

    const wrong = await post(f, `/statement-lines/${line.id}/match`, { journalLineIds: [a, c] });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe("SPLIT_TOTAL_MISMATCH");
    expect((await post(f, `/statement-lines/${line.id}/match`, { journalLineIds: [a, b] })).status).toBe(200);
  });

  it("refuses a journal line that's on another account, already used, or from another business", async () => {
    const { f, line } = await setupLine();
    const cash = await expense(f, { accountId: f.cashId });
    const cashLine = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: cash.body.data.journalEntryId, creditMinor: { gt: 0 } } });
    expect((await post(f, `/statement-lines/${line.id}/match`, { journalLineIds: [cashLine.id] })).status).toBe(422);

    const other = await setupFinance();
    const foreign = await expense(other);
    const foreignLine = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: foreign.body.data.journalEntryId, creditMinor: { gt: 0 } } });
    expect((await post(f, `/statement-lines/${line.id}/match`, { journalLineIds: [foreignLine.id] })).status).toBe(422);
  });

  it("categorize creates a transaction, draft or posted", async () => {
    const { f, line } = await setupLine();
    const res = await post(f, `/statement-lines/${line.id}/categorize`, { categoryId: f.rentId, postNow: true, description: "Rent" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("MATCHED");
    const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: res.body.data.transactionId } });
    expect(transaction).toMatchObject({ status: "POSTED", source: "IMPORT", description: "Rent", amountMinor: 300000n });

    const again = await post(f, `/statement-lines/${line.id}/categorize`, { categoryId: f.rentId });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("STATEMENT_LINE_NOT_OPEN");
  });

  it("two people categorizing at once create one transaction", async () => {
    const { f, line } = await setupLine();
    const results = await Promise.all([1, 2, 3].map(() => post(f, `/statement-lines/${line.id}/categorize`, { categoryId: f.rentId, postNow: true })));
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(await prisma.transaction.count({ where: { businessId: f.businessId, source: "IMPORT" } })).toBe(1);
  });

  it("the wrong category leaves nothing behind", async () => {
    const { f, line } = await setupLine();
    expect((await post(f, `/statement-lines/${line.id}/categorize`, { categoryId: f.salesId })).status).toBe(422);
    expect((await onlyLine(f)).status).toBe("UNMATCHED");
    expect(await prisma.statementLineLink.count({ where: { statementLineId: line.id } })).toBe(0);
  });

  it("without postNow it stays a draft, with nothing in the ledger", async () => {
    const { f, line } = await setupLine();
    const before = await prisma.journalEntry.count({ where: { businessId: f.businessId } });
    const res = await post(f, `/statement-lines/${line.id}/categorize`, { categoryId: f.rentId });
    expect(res.body.data.status).toBe("AWAITING_POSTING");
    expect(await prisma.journalEntry.count({ where: { businessId: f.businessId } })).toBe(before);
  });

  it("transfer: a line out of the bank moves money to the wallet, and the wallet's line then matches itself", async () => {
    const f = await setupFinance();
    const wallet = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "bKash", type: "BKASH" });
    await importStatement(f, `${HEADER}\n05/11/2026,To bKash,,10000.00,,\n`);
    const bankLine = await onlyLine(f);
    const res = await post(f, `/statement-lines/${bankLine.id}/categorize`, { transferAccountId: wallet.body.data.id, postNow: true });
    expect(res.body.data.status).toBe("MATCHED");

    await importStatement(f, `${HEADER}\n05/11/2026,From bank,,,10000.00,\n`, wallet.body.data.id);
    const [walletLine] = await linesOf(f, `&financialAccountId=${wallet.body.data.id}`);
    expect(walletLine).toMatchObject({ status: "MATCHED", matchedBy: "AMOUNT_DATE" });
  });

  it("split needs at least two parts adding up to the line, and is all or nothing", async () => {
    const { f, line } = await setupLine();
    const split = (parts: object[], postNow = true) => post(f, `/statement-lines/${line.id}/split`, { parts, postNow });

    const wrong = await split([{ categoryId: f.rentId, amountMinor: "100000" }, { categoryId: f.rentId, amountMinor: "100000" }]);
    expect(wrong.body.error.code).toBe("SPLIT_TOTAL_MISMATCH");

    const badPart = await split([{ categoryId: f.rentId, amountMinor: "100000" }, { categoryId: f.salesId, amountMinor: "200000" }]);
    expect(badPart.status).toBe(422);
    expect(await prisma.transaction.count({ where: { businessId: f.businessId, source: "IMPORT" } })).toBe(0);

    const good = await split([{ categoryId: f.rentId, amountMinor: "100000", description: "Part A" }, { categoryId: f.rentId, amountMinor: "200000" }]);
    expect(good.status).toBe(200);
    expect(good.body.data.status).toBe("MATCHED");
    expect(good.body.data.transactionIds).toHaveLength(2);
    expect(await prisma.statementLineLink.count({ where: { statementLineId: line.id, journalLineId: { not: null } } })).toBe(2);
  });

  it("ignore and restore", async () => {
    const { f, line } = await setupLine();
    expect((await post(f, `/statement-lines/${line.id}/ignore`)).body.data.status).toBe("IGNORED");
    expect((await post(f, `/statement-lines/${line.id}/categorize`, { categoryId: f.rentId })).status).toBe(409);
    expect((await post(f, `/statement-lines/${line.id}/restore`)).body.data.status).toBe("UNMATCHED");
  });

  it("a viewer can't act", async () => {
    const { f, line } = await setupLine();
    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    const res = await api().post(`${f.base}/statement-lines/${line.id}/ignore`).set("Authorization", bearer(viewer));
    expect(res.status).toBe(403);
  });
});

describe("when the books change afterwards", () => {
  const draftFromLine = async () => {
    const f = await setupFinance();
    await importStatement(f, rentLine("", "02/11/2026", "Unknown"));
    const line = await onlyLine(f);
    const res = await post(f, `/statement-lines/${line.id}/categorize`, { categoryId: f.rentId });
    return { f, line, transactionId: res.body.data.transactionId as string };
  };

  it("posting the draft settles the line", async () => {
    const { f, line, transactionId } = await draftFromLine();
    expect((await onlyLine(f)).status).toBe("AWAITING_POSTING");
    expect((await post(f, `/transactions/${transactionId}/post`)).status).toBe(200);
    await runPendingEvents();
    expect((await onlyLine(f)).status).toBe("MATCHED");
    expect(await prisma.statementLineLink.count({ where: { statementLineId: line.id, journalLineId: { not: null } } })).toBe(1);
  });

  it("voiding the draft sends the line back to the inbox", async () => {
    const { f, transactionId } = await draftFromLine();
    expect((await post(f, `/transactions/${transactionId}/void`)).status).toBe(200);
    expect(await statementLinesService.settlePendingLinks(f.businessId)).toBe(1);
    expect((await onlyLine(f)).status).toBe("UNMATCHED");
  });

  it("reversing a matched transaction sends the line back too", async () => {
    const f = await setupFinance();
    const { body } = await expense(f);
    await importStatement(f, rentLine());
    expect((await onlyLine(f)).status).toBe("MATCHED");
    await post(f, `/transactions/${body.data.id}/reverse`);
    await statementLinesService.settlePendingLinks(f.businessId);
    expect((await onlyLine(f)).status).toBe("UNMATCHED");
  });
});

describe("reconciliation", () => {
  const start = (f: FinanceSetup, balance: string) => post(f, "/reconciliations", { financialAccountId: f.bankId, statementDate: "2026-11-30", statementBalanceMinor: balance });

  it("matched lines clear it, and it reaches zero", async () => {
    const f = await setupFinance();
    await income(f);
    await expense(f);
    await importStatement(f, `${HEADER}\n01/11/2026,Sale,,,5000.00,5000.00\n02/11/2026,Rent,,3000.00,,2000.00\n`);
    expect((await linesOf(f, "&status=MATCHED"))).toHaveLength(2);

    const { body } = await start(f, "200000");
    const before = await api().get(`${f.base}/reconciliations/${body.data.id}`).set("Authorization", f.auth);
    expect(before.body.data).toMatchObject({ openStatementLines: 0, latestStatementBalance: { balanceMinor: "200000", asOf: "2026-11-02" } });
    expect(before.body.data.differenceMinor).toBe("200000");

    const applied = await post(f, `/reconciliations/${body.data.id}/apply-statement-matches`);
    expect(applied.body.data).toMatchObject({ applied: 2, differenceMinor: "0" });
    expect((await post(f, `/reconciliations/${body.data.id}/close`)).status).toBe(200);
  });

  it("applying twice adds nothing, and a line after the statement date stays out", async () => {
    const f = await setupFinance();
    await expense(f, { txnDate: "2026-12-05", amountMinor: "100" });
    await importStatement(f, `${HEADER}\n05/12/2026,Later,,1.00,,\n`);
    const { body } = await start(f, "0");
    expect((await post(f, `/reconciliations/${body.data.id}/apply-statement-matches`)).body.data.applied).toBe(0);
  });

  it("shows how many statement lines are still open", async () => {
    const f = await setupFinance();
    await importStatement(f, `${HEADER}\n02/11/2026,Unknown,,1.00,,\n`);
    const { body } = await start(f, "0");
    const res = await api().get(`${f.base}/reconciliations/${body.data.id}`).set("Authorization", f.auth);
    expect(res.body.data.openStatementLines).toBe(1);
  });

  it("a reconciled line can't be unmatched", async () => {
    const f = await setupFinance();
    await expense(f);
    await importStatement(f, rentLine());
    const { body } = await start(f, "-300000");
    await post(f, `/reconciliations/${body.data.id}/apply-statement-matches`);
    const line = await onlyLine(f);
    const res = await post(f, `/statement-lines/${line.id}/unmatch`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STATEMENT_LINE_RECONCILED");
  });
});
