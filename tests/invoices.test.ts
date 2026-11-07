import { describe, expect, it, vi } from "vitest";
import { buildInvoiceLines, lineAmountMinor, totals } from "../src/app/utils/postingRules.js";
import { sendEmail } from "../src/lib/mailer.js";
import { prisma } from "../src/lib/prisma.js";
import { addMember, api, setupFinance, type FinanceSetup } from "./helpers/api.js";

vi.mock("../src/lib/mailer.js", () => ({ emailEnabled: vi.fn(() => true), sendEmail: vi.fn(async () => {}) }));
const mockedEmail = vi.mocked(sendEmail);

const invoices = (f: FinanceSetup) => `${f.base}/invoices`;
const contact = async (f: FinanceSetup, kind: string, name: string, email?: string) =>
  (await api().post(`${f.base}/contacts`).set("Authorization", f.auth).send({ kind, name, ...(email ? { email } : {}) })).body.data.id as string;

const makeInvoice = (f: FinanceSetup, body: object) =>
  api()
    .post(invoices(f))
    .set("Authorization", f.auth)
    .send({ kind: "SALE", issueDate: "2026-11-01", dueDate: "2026-11-15", ...body });

const pay = (f: FinanceSetup, id: string, body: object) =>
  api().post(`${invoices(f)}/${id}/payments`).set("Authorization", f.auth).send({ accountId: f.cashId, paidOn: "2026-11-05", ...body });

// Net debit on a ledger account, by its code, across everything posted in the business.
const ledgerBalance = async (f: FinanceSetup, code: string) => {
  const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { businessId: f.businessId, code } });
  const sums = await prisma.journalLine.aggregate({ where: { ledgerAccountId: account.id }, _sum: { debitMinor: true, creditMinor: true } });
  return (sums._sum.debitMinor ?? 0n) - (sums._sum.creditMinor ?? 0n);
};

const cashBalance = async (f: FinanceSetup) =>
  (await prisma.financialAccount.findUniqueOrThrow({ where: { id: f.cashId } })).currentBalanceMinor;

describe("invoice posting rules", () => {
  it("works out line amounts, rounding half up", () => {
    expect(lineAmountMinor("2", 150000n)).toBe(300000n);
    expect(lineAmountMinor("2.5", 1000n)).toBe(2500n);
    expect(lineAmountMinor("0.333", 100n)).toBe(33n);
    expect(lineAmountMinor("0.335", 100n)).toBe(34n);
    expect(lineAmountMinor("1.005", 100n)).toBe(101n);
  });

  it("always balances, and adds up lines on the same account", () => {
    for (const kind of ["SALE", "BILL"] as const) {
      const lines = buildInvoiceLines({
        kind,
        controlLedgerId: "control",
        memo: "INV",
        lines: [
          { ledgerAccountId: "a", amountMinor: 100n },
          { ledgerAccountId: "b", amountMinor: 250n },
          { ledgerAccountId: "a", amountMinor: 50n },
          { ledgerAccountId: "c", amountMinor: 0n },
        ],
      });
      const sums = totals(lines);
      expect(sums.debit).toBe(400n);
      expect(sums.credit).toBe(400n);
      expect(lines).toHaveLength(3);
    }
  });
});

describe("invoices and bills", () => {
  it("drafts, changes and issues an invoice, posting receivables against sales", async () => {
    const f = await setupFinance();
    const karim = await contact(f, "CUSTOMER", "Karim Fashion");
    const draft = await makeInvoice(f, {
      contactId: karim,
      lines: [
        { description: "Shirts", quantity: "10", unitPriceMinor: "50000", categoryId: f.salesId },
        { description: "Delivery", quantity: "1", unitPriceMinor: "10000", categoryId: f.salesId },
      ],
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({ status: "DRAFT", number: null, totalMinor: "510000", dueMinor: "510000", currency: "BDT" });
    expect(draft.body.data.lines[0]).toMatchObject({ lineNo: 1, quantity: "10", amountMinor: "500000" });
    const id = draft.body.data.id as string;

    // Nothing reaches the books until it is issued.
    expect(await ledgerBalance(f, "1200")).toBe(0n);

    const changed = await api()
      .patch(`${invoices(f)}/${id}`)
      .set("Authorization", f.auth)
      .send({ lines: [{ description: "Shirts", quantity: "12.5", unitPriceMinor: "40000", categoryId: f.salesId }], notes: "Thank you" });
    expect(changed.body.data).toMatchObject({ totalMinor: "500000", notes: "Thank you" });
    expect(changed.body.data.lines).toHaveLength(1);

    const issued = await api().post(`${invoices(f)}/${id}/issue`).set("Authorization", f.auth);
    expect(issued.status).toBe(200);
    expect(issued.body.data).toMatchObject({ status: "ISSUED", number: "INV-2026-000001" });
    expect(await ledgerBalance(f, "1200")).toBe(500000n);
    expect(await ledgerBalance(f, "4000")).toBe(-500000n);

    // Issued means fixed: no edits, no deleting, no issuing twice.
    expect((await api().patch(`${invoices(f)}/${id}`).set("Authorization", f.auth).send({ notes: "x" })).body.error.code).toBe("INVOICE_NOT_DRAFT");
    expect((await api().delete(`${invoices(f)}/${id}`).set("Authorization", f.auth)).body.error.code).toBe("INVOICE_NOT_DRAFT");
    expect((await api().post(`${invoices(f)}/${id}/issue`).set("Authorization", f.auth)).body.error.code).toBe("INVOICE_NOT_DRAFT");

    // The next one takes the next number.
    const second = await makeInvoice(f, { contactId: karim, issue: true, lines: [{ description: "Belts", quantity: "1", unitPriceMinor: "1000", categoryId: f.salesId }] });
    expect(second.body.data.number).toBe("INV-2026-000002");

    const actions = (await prisma.auditLog.findMany({ where: { entityType: "invoice" }, orderBy: { id: "asc" } })).map((row) => row.action);
    expect(actions).toEqual(["invoice.created", "invoice.updated", "invoice.issued", "invoice.created", "invoice.issued"]);
  });

  it("records part and full payments, moves cash and receivables, and undoes a payment", async () => {
    const f = await setupFinance();
    const karim = await contact(f, "CUSTOMER", "Karim");
    const made = await makeInvoice(f, { contactId: karim, issue: true, lines: [{ description: "Goods", quantity: "1", unitPriceMinor: "100000", categoryId: f.salesId }] });
    const id = made.body.data.id as string;
    const cashBefore = await cashBalance(f);

    const part = await pay(f, id, { amountMinor: "40000" });
    expect(part.status).toBe(201);
    expect(part.body.data).toMatchObject({ status: "PARTIALLY_PAID", paidMinor: "40000", dueMinor: "60000" });
    expect(await ledgerBalance(f, "1200")).toBe(60000n);
    expect((await cashBalance(f)) - cashBefore).toBe(40000n);

    const tooMuch = await pay(f, id, { amountMinor: "60001" });
    expect(tooMuch.body.error).toMatchObject({ code: "PAYMENT_EXCEEDS_DUE", params: { dueMinor: "60000" } });

    const rest = await pay(f, id, { amountMinor: "60000", accountId: f.bankId, note: "bKash" });
    expect(rest.body.data).toMatchObject({ status: "PAID", dueMinor: "0" });
    expect(await ledgerBalance(f, "1200")).toBe(0n);
    expect((await pay(f, id, { amountMinor: "1" })).body.error.code).toBe("INVOICE_NOT_OPEN");
    const totals = (await api().get(`${f.base}/contacts/${karim}`).set("Authorization", f.auth)).body.data.totals;
    expect(totals).toEqual([{ currency: "BDT", receivedMinor: "100000", paidMinor: "0", transactions: 2, lastDate: "2026-11-05" }]);

    // Undo the bank payment: back to part-paid, receivables up again, journal reversed.
    const paymentId = rest.body.data.payments[1].id as string;
    const undone = await api().post(`${invoices(f)}/${id}/payments/${paymentId}/void`).set("Authorization", f.auth);
    expect(undone.body.data).toMatchObject({ status: "PARTIALLY_PAID", paidMinor: "40000" });
    expect(undone.body.data.payments[1].voidedAt).not.toBeNull();
    expect(await ledgerBalance(f, "1200")).toBe(60000n);
    expect((await api().post(`${invoices(f)}/${id}/payments/${paymentId}/void`).set("Authorization", f.auth)).body.error.code).toBe("PAYMENT_ALREADY_VOID");

    // An invoice with money against it can't be voided until the payments are undone.
    const voidNow = () => api().post(`${invoices(f)}/${id}/void`).set("Authorization", f.auth).send({ reason: "Wrong customer" });
    expect((await voidNow()).body.error.code).toBe("INVOICE_HAS_PAYMENTS");
    await api().post(`${invoices(f)}/${id}/payments/${part.body.data.payments[0].id}/void`).set("Authorization", f.auth);
    const voided = await voidNow();
    expect(voided.body.data).toMatchObject({ status: "VOID", voidReason: "Wrong customer", dueMinor: "0" });
    expect(await ledgerBalance(f, "1200")).toBe(0n);
    expect(await ledgerBalance(f, "4000")).toBe(0n);
    expect(await cashBalance(f)).toBe(cashBefore);
  });

  it("posts a bill to payables and an expense, and pays it from an account", async () => {
    const f = await setupFinance();
    const supplier = await contact(f, "SUPPLIER", "Dhaka Fabrics");
    const bill = await api()
      .post(invoices(f))
      .set("Authorization", f.auth)
      .send({
        kind: "BILL",
        contactId: supplier,
        issueDate: "2026-11-02",
        dueDate: "2026-12-02",
        referenceNo: "DF-778",
        issue: true,
        lines: [{ description: "November rent", quantity: "1", unitPriceMinor: "2500000", categoryId: f.rentId }],
      });
    expect(bill.body.data).toMatchObject({ kind: "BILL", status: "ISSUED", number: "BILL-2026-000001", referenceNo: "DF-778" });
    expect(await ledgerBalance(f, "2000")).toBe(-2500000n);

    await api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({
      type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "3000000", txnDate: "2026-11-01", postNow: true,
    });
    const paid = await pay(f, bill.body.data.id, { amountMinor: "2500000", accountId: f.bankId, paidOn: "2026-11-20" });
    expect(paid.body.data.status).toBe("PAID");
    expect(await ledgerBalance(f, "2000")).toBe(0n);
    const bank = await prisma.financialAccount.findUniqueOrThrow({ where: { id: f.bankId } });
    expect(bank.currentBalanceMinor).toBe(500000n);
  });

  it("refuses the wrong contact kind, the wrong category side, a zero invoice and bad dates", async () => {
    const f = await setupFinance();
    const supplier = await contact(f, "SUPPLIER", "Supplier only");
    const customer = await contact(f, "CUSTOMER", "Customer");
    const both = await contact(f, "BOTH", "Both ways");
    const goods = [{ description: "Goods", quantity: "1", unitPriceMinor: "100", categoryId: f.salesId }];

    expect((await makeInvoice(f, { contactId: supplier, lines: goods })).body.error.code).toBe("CONTACT_KIND_MISMATCH");
    expect((await makeInvoice(f, { contactId: both, lines: goods })).status).toBe(201);
    const rentOnInvoice = await makeInvoice(f, { contactId: customer, lines: [{ ...goods[0], categoryId: f.rentId }] });
    expect(rentOnInvoice.body.error).toMatchObject({ code: "CATEGORY_TYPE_MISMATCH", params: { line: 1, expected: "INCOME" } });

    const zero = await makeInvoice(f, { contactId: customer, issue: true, lines: [{ ...goods[0], unitPriceMinor: "0" }] });
    expect(zero.body.error.code).toBe("INVOICE_TOTAL_ZERO");
    expect(await prisma.invoice.count({ where: { businessId: f.businessId, totalMinor: 0n } })).toBe(0);

    expect((await makeInvoice(f, { contactId: customer, dueDate: "2026-10-01", lines: goods })).status).toBe(422);
    expect((await makeInvoice(f, { contactId: customer, lines: [] })).status).toBe(422);
    expect((await makeInvoice(f, { contactId: customer, lines: [{ ...goods[0], quantity: "0" }] })).status).toBe(422);

    // A draft can be deleted outright.
    const draft = (await makeInvoice(f, { contactId: customer, lines: goods })).body.data.id as string;
    expect((await api().delete(`${invoices(f)}/${draft}`).set("Authorization", f.auth)).status).toBe(204);
    expect((await api().get(`${invoices(f)}/${draft}`).set("Authorization", f.auth)).status).toBe(404);
  });

  it("lists by status, overdue and search, and keeps another business out", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    const karim = await contact(f, "CUSTOMER", "Karim");
    const rahim = await contact(f, "CUSTOMER", "Rahim");
    const line = [{ description: "Goods", quantity: "1", unitPriceMinor: "1000", categoryId: f.salesId }];
    await makeInvoice(f, { contactId: karim, issue: true, lines: line, dueDate: "2026-11-02" });
    await makeInvoice(f, { contactId: rahim, issue: true, lines: line, referenceNo: "PO-55" });
    await makeInvoice(f, { contactId: rahim, lines: line });

    const list = (query: object) => api().get(invoices(f)).query({ kind: "SALE", ...query }).set("Authorization", f.auth);
    expect((await list({})).body.data).toHaveLength(3);
    expect((await list({ status: "DRAFT" })).body.data).toHaveLength(1);
    expect((await list({ kind: "BILL" })).body.data).toHaveLength(0);
    const overdue = (await list({ overdue: "true" })).body.data;
    expect(overdue.every((row: { isOverdue: boolean }) => row.isOverdue)).toBe(true);
    expect((await list({ search: "po-55" })).body.data).toHaveLength(1);
    expect((await list({ search: "rahim" })).body.data).toHaveLength(2);
    expect((await list({ contactId: karim })).body.data[0].contact.name).toBe("Karim");

    const mine = (await list({})).body.data[0].id as string;
    expect((await api().get(`${invoices(other)}/${mine}`).set("Authorization", other.auth)).status).toBe(404);
    expect((await makeInvoice(other, { contactId: karim, lines: [{ ...line[0], categoryId: other.salesId }] })).body.error.code).toBe("CONTACT_NOT_USABLE");
  });

  it("works out baki by days past due, per contact", async () => {
    const f = await setupFinance();
    const karim = await contact(f, "CUSTOMER", "Karim");
    const rahim = await contact(f, "CUSTOMER", "Rahim");
    const line = (amount: string) => [{ description: "Goods", quantity: "1", unitPriceMinor: amount, categoryId: f.salesId }];
    const issue = (contactId: string, amount: string, issueDate: string, dueDate: string) =>
      makeInvoice(f, { contactId, issue: true, issueDate, dueDate, lines: line(amount) });

    await issue(karim, "10000", "2026-07-01", "2026-07-10"); // over 90 days past due on 2026-11-30
    await issue(karim, "20000", "2026-10-01", "2026-10-20"); // 41 days
    const partly = await issue(rahim, "30000", "2026-11-01", "2026-11-25"); // 5 days
    await pay(f, partly.body.data.id, { amountMinor: "5000", paidOn: "2026-11-26" });
    await issue(rahim, "40000", "2026-11-20", "2026-12-20"); // not due yet
    await makeInvoice(f, { contactId: rahim, lines: line("99999") }); // a draft doesn't count

    const aging = await api().get(`${invoices(f)}/aging`).query({ kind: "SALE", asOf: "2026-11-30" }).set("Authorization", f.auth);
    expect(aging.status).toBe(200);
    expect(aging.body.data.totals).toEqual({ current: "40000", days1to30: "25000", days31to60: "20000", days61to90: "0", over90: "10000", totalMinor: "95000" });
    expect(aging.body.data.rows.map((row: { contactName: string; totalMinor: string }) => [row.contactName, row.totalMinor])).toEqual([
      ["Rahim", "65000"],
      ["Karim", "30000"],
    ]);
    expect(aging.body.data.rows[1]).toMatchObject({ invoices: 2, oldestDueDate: "2026-07-10" });

    const one = await api().get(`${invoices(f)}/aging`).query({ kind: "SALE", asOf: "2026-11-30", contactId: karim }).set("Authorization", f.auth);
    expect(one.body.data.totals.totalMinor).toBe("30000");
    // As of an earlier day, invoices issued later are left out.
    const earlier = await api().get(`${invoices(f)}/aging`).query({ kind: "SALE", asOf: "2026-08-01" }).set("Authorization", f.auth);
    expect(earlier.body.data.totals.totalMinor).toBe("10000");
  });

  it("makes a PDF and emails an issued invoice to the customer", async () => {
    mockedEmail.mockClear();
    const f = await setupFinance();
    const karim = await contact(f, "CUSTOMER", "Karim <Fashion>", "karim@shop.test");
    const made = await makeInvoice(f, { contactId: karim, lines: [{ description: "শার্ট", quantity: "2", unitPriceMinor: "50000", categoryId: f.salesId }] });
    const id = made.body.data.id as string;

    // A draft can't be sent yet.
    expect((await api().post(`${invoices(f)}/${id}/email`).set("Authorization", f.auth).send({})).body.error.code).toBe("INVOICE_NOT_SENDABLE");
    await api().post(`${invoices(f)}/${id}/issue`).set("Authorization", f.auth);

    const file = await api().get(`${invoices(f)}/${id}/pdf`).query({ locale: "bn-BD" }).set("Authorization", f.auth).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["content-disposition"]).toContain("INV-2026-000001.pdf");
    expect(Buffer.from(file.body).subarray(0, 4).toString()).toBe("%PDF");

    const sent = await api().post(`${invoices(f)}/${id}/email`).set("Authorization", f.auth).send({ message: "Thanks for your order" });
    expect(sent.status).toBe(200);
    expect(sent.body.data.emailedAt).not.toBeNull();
    expect(mockedEmail).toHaveBeenCalledTimes(1);
    const email = mockedEmail.mock.calls[0]![0];
    expect(email).toMatchObject({ to: "karim@shop.test", subject: expect.stringContaining("INV-2026-000001") });
    expect(email.html).toContain("Karim &lt;Fashion&gt;");
    expect(email.attachments![0]!.content.subarray(0, 4).toString()).toBe("%PDF");
  }, 30000);

  it("follows the money permissions", async () => {
    const f = await setupFinance();
    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    const auth = `Bearer ${viewer.accessToken}`;
    const read = await api().get(invoices(f)).query({ kind: "SALE" }).set("Authorization", auth);
    expect(read.body.error).toMatchObject({ code: "PERMISSION_DENIED", params: { permission: "finance.read" } });
  });
});
