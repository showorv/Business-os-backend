import { describe, expect, it } from "vitest";
import { buildInvoiceLines, lineVatMinor, totals } from "../src/app/utils/postingRules.js";
import { prisma } from "../src/lib/prisma.js";
import { addMember, api, setupFinance, type FinanceSetup } from "./helpers/api.js";

const contact = async (f: FinanceSetup, kind: string, name: string, taxId?: string) =>
  (await api().post(`${f.base}/contacts`).set("Authorization", f.auth).send({ kind, name, ...(taxId ? { taxId } : {}) })).body.data.id as string;

const register = (f: FinanceSetup, vatRegistered = true) =>
  api().patch(f.base).set("Authorization", f.auth).send({ settings: { vatRegistered } });

const issue = (f: FinanceSetup, body: object) =>
  api()
    .post(`${f.base}/invoices`)
    .set("Authorization", f.auth)
    .send({ kind: "SALE", issueDate: "2026-11-05", dueDate: "2026-11-20", issue: true, ...body });

const ledgerBalance = async (f: FinanceSetup, code: string) => {
  const account = await prisma.ledgerAccount.findFirst({ where: { businessId: f.businessId, code } });
  if (!account) return null;
  const sums = await prisma.journalLine.aggregate({ where: { ledgerAccountId: account.id }, _sum: { debitMinor: true, creditMinor: true } });
  return (sums._sum.debitMinor ?? 0n) - (sums._sum.creditMinor ?? 0n);
};

const summary = (f: FinanceSetup, from = "2026-11-01", to = "2026-11-30") =>
  api().get(`${f.base}/vat/summary`).query({ from, to }).set("Authorization", f.auth);

describe("VAT posting rules", () => {
  it("works out line VAT, rounding half up", () => {
    expect(lineVatMinor(100000n, 1500)).toBe(15000n);
    expect(lineVatMinor(333n, 750)).toBe(25n); // 24.975
    expect(lineVatMinor(10n, 500)).toBe(1n); // 0.5 rounds up
    expect(lineVatMinor(100000n, 0)).toBe(0n);
  });

  it("balances with VAT on either side", () => {
    for (const kind of ["SALE", "BILL"] as const) {
      const lines = buildInvoiceLines({
        kind,
        controlLedgerId: "control",
        memo: "x",
        lines: [{ ledgerAccountId: "a", amountMinor: 1000n }],
        vat: { ledgerAccountId: "vat", amountMinor: 150n },
      });
      expect(totals(lines)).toEqual({ debit: 1150n, credit: 1150n });
    }
  });
});

describe("VAT on invoices and bills", () => {
  it("adds VAT to an invoice and posts it to VAT Payable, for a registered business", async () => {
    const f = await setupFinance();
    await register(f);
    const karim = await contact(f, "CUSTOMER", "Karim Fashion", "000123456-0101");
    const made = await issue(f, {
      contactId: karim,
      lines: [
        { description: "Shirts", quantity: "10", unitPriceMinor: "50000", categoryId: f.salesId, vatRateBp: 1500 },
        { description: "Rice", quantity: "1", unitPriceMinor: "20000", categoryId: f.salesId },
      ],
    });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ subtotalMinor: "520000", vatMinor: "75000", totalMinor: "595000", dueMinor: "595000" });
    expect(made.body.data.lines[0]).toMatchObject({ vatRateBp: 1500, vatMinor: "75000" });
    expect(made.body.data.lines[1]).toMatchObject({ vatRateBp: 0, vatMinor: "0" });

    expect(await ledgerBalance(f, "1200")).toBe(595000n);
    expect(await ledgerBalance(f, "4000")).toBe(-520000n);
    expect(await ledgerBalance(f, "2200")).toBe(-75000n);
  });

  it("refuses VAT on an invoice until the business is VAT-registered", async () => {
    const f = await setupFinance();
    const karim = await contact(f, "CUSTOMER", "Karim");
    const line = { description: "Shirts", quantity: "1", unitPriceMinor: "1000", categoryId: f.salesId, vatRateBp: 1500 };
    expect((await issue(f, { contactId: karim, lines: [line] })).body.error.code).toBe("VAT_NOT_REGISTERED");
    // Without VAT it is fine.
    expect((await issue(f, { contactId: karim, lines: [{ ...line, vatRateBp: 0 }] })).status).toBe(201);

    // A draft made while registered can't be issued after the registration is switched off.
    await register(f);
    const draft = await issue(f, { contactId: karim, lines: [line], issue: false });
    await register(f, false);
    const late = await api().post(`${f.base}/invoices/${draft.body.data.id}/issue`).set("Authorization", f.auth);
    expect(late.body.error.code).toBe("VAT_NOT_REGISTERED");
  });

  it("claims a bill's VAT back when registered, and adds it to the cost when not", async () => {
    const registered = await setupFinance();
    await register(registered);
    const supplier = await contact(registered, "SUPPLIER", "Dhaka Fabrics");
    const line = { description: "Rent", quantity: "1", unitPriceMinor: "100000", categoryId: registered.rentId, vatRateBp: 1500 };
    const bill = await issue(registered, { kind: "BILL", contactId: supplier, lines: [line] });
    expect(bill.body.data).toMatchObject({ totalMinor: "115000", vatRecoverable: true });
    expect(await ledgerBalance(registered, "1400")).toBe(15000n);
    expect(await ledgerBalance(registered, "6100")).toBe(100000n);
    expect(await ledgerBalance(registered, "2000")).toBe(-115000n);

    const unregistered = await setupFinance();
    const other = await contact(unregistered, "SUPPLIER", "Landlord");
    const cost = await issue(unregistered, { kind: "BILL", contactId: other, lines: [{ ...line, categoryId: unregistered.rentId }] });
    expect(cost.body.data).toMatchObject({ totalMinor: "115000", vatRecoverable: false });
    expect(await ledgerBalance(unregistered, "1400") ?? 0n).toBe(0n);
    expect(await ledgerBalance(unregistered, "6100")).toBe(115000n);
  });

  it("sums output and input VAT by rate for a period, leaving out drafts, voids and other months", async () => {
    const f = await setupFinance();
    await register(f);
    const karim = await contact(f, "CUSTOMER", "Karim", "000123456-0101");
    const supplier = await contact(f, "SUPPLIER", "Dhaka Fabrics");
    const sale = (amount: string, vatRateBp: number) => ({ description: "Goods", quantity: "1", unitPriceMinor: amount, categoryId: f.salesId, vatRateBp });

    await issue(f, { contactId: karim, lines: [sale("100000", 1500), sale("40000", 500)] });
    await issue(f, { contactId: karim, lines: [sale("60000", 1500), sale("10000", 0)] });
    await issue(f, { kind: "BILL", contactId: supplier, lines: [{ description: "Rent", quantity: "1", unitPriceMinor: "50000", categoryId: f.rentId, vatRateBp: 1500 }] });
    // Left out: a draft, a voided invoice and one from October.
    await issue(f, { contactId: karim, lines: [sale("999999", 1500)], issue: false });
    const wrong = await issue(f, { contactId: karim, lines: [sale("888888", 1500)] });
    await api().post(`${f.base}/invoices/${wrong.body.data.id}/void`).set("Authorization", f.auth).send({ reason: "Twice" });
    await issue(f, { contactId: karim, issueDate: "2026-10-20", dueDate: "2026-10-30", lines: [sale("777777", 1500)] });

    const result = await summary(f);
    expect(result.status).toBe(200);
    const data = result.body.data;
    expect(data).toMatchObject({ registered: true, currency: "BDT", netMinor: "18500" });
    expect(data.output).toEqual({
      rows: [
        { rateBp: 1500, taxableMinor: "160000", vatMinor: "24000" },
        { rateBp: 500, taxableMinor: "40000", vatMinor: "2000" },
        { rateBp: 0, taxableMinor: "10000", vatMinor: "0" },
      ],
      taxableMinor: "210000",
      vatMinor: "26000",
      documents: 2,
    });
    expect(data.input).toMatchObject({ taxableMinor: "50000", vatMinor: "7500", documents: 1 });
    expect(data.documents).toHaveLength(3);
    const firstSale = data.documents.find((doc: { kind: string }) => doc.kind === "SALE");
    expect(firstSale).toMatchObject({ number: "INV-2026-000001", contactTaxId: "000123456-0101", vatMinor: "17000" });

    expect((await summary(f, "2026-12-01", "2026-11-01")).status).toBe(422);
    expect((await summary(f, "2025-01-01", "2026-11-30")).status).toBe(422);
  });

  it("prints VAT on the PDF and follows the money permissions", async () => {
    const f = await setupFinance();
    await register(f);
    const karim = await contact(f, "CUSTOMER", "Karim");
    const made = await issue(f, { contactId: karim, lines: [{ description: "Shirts", quantity: "1", unitPriceMinor: "1000", categoryId: f.salesId, vatRateBp: 1500 }] });
    const file = await api().get(`${f.base}/invoices/${made.body.data.id}/pdf`).set("Authorization", f.auth).buffer(true);
    expect(Buffer.from(file.body).subarray(0, 4).toString()).toBe("%PDF");

    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    const read = await api().get(`${f.base}/vat/summary`).query({ from: "2026-11-01", to: "2026-11-30" }).set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(read.body.error.code).toBe("PERMISSION_DENIED");
  }, 30000);
});
