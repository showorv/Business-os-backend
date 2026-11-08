import { withBusinessScope } from "../../../lib/rls.js";
import { fromDbDate, toDbDate } from "../../utils/dates.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { IVatDocument, IVatSide, IVatSummary, IVatSummaryQuery } from "./vat.interface.js";

// What a VAT return needs for a period, from issued invoices and bills by their date. Voided ones and
// drafts are left out. This helps fill in the return (Mushak 9.1); it is not the return itself.
const summary = (business: BusinessContext, query: IVatSummaryQuery) =>
  withBusinessScope(business, async (tx): Promise<IVatSummary> => {
    const { settings } = await tx.business.findUniqueOrThrow({ where: { id: business.businessId }, select: { settings: true } });
    const invoices = await tx.invoice.findMany({
      where: {
        businessId: business.businessId,
        status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] },
        issueDate: { gte: toDbDate(query.from), lte: toDbDate(query.to) },
      },
      include: {
        contact: { select: { name: true, taxId: true } },
        lines: { select: { amountMinor: true, vatRateBp: true, vatMinor: true } },
      },
      orderBy: [{ issueDate: "asc" }, { number: "asc" }],
    });

    const side = (): { byRate: Map<number, { taxable: bigint; vat: bigint }>; documents: number } => ({ byRate: new Map(), documents: 0 });
    const output = side();
    const input = side();
    for (const invoice of invoices) {
      // A bill's VAT that can't be claimed back isn't input VAT: it was part of the cost.
      const target = invoice.kind === "SALE" ? output : invoice.vatRecoverable ? input : null;
      if (!target) continue;
      target.documents += 1;
      for (const line of invoice.lines) {
        const row = target.byRate.get(line.vatRateBp) ?? { taxable: 0n, vat: 0n };
        row.taxable += line.amountMinor;
        row.vat += line.vatMinor;
        target.byRate.set(line.vatRateBp, row);
      }
    }

    const toSide = ({ byRate, documents }: ReturnType<typeof side>): IVatSide => {
      const rows = [...byRate]
        .sort(([a], [b]) => b - a)
        .map(([rateBp, row]) => ({ rateBp, taxableMinor: row.taxable.toString(), vatMinor: row.vat.toString() }));
      return {
        rows,
        taxableMinor: [...byRate.values()].reduce((sum, row) => sum + row.taxable, 0n).toString(),
        vatMinor: [...byRate.values()].reduce((sum, row) => sum + row.vat, 0n).toString(),
        documents,
      };
    };
    const outputSide = toSide(output);
    const inputSide = toSide(input);

    const documents: IVatDocument[] = invoices.map((invoice) => ({
      invoiceId: invoice.id,
      kind: invoice.kind,
      number: invoice.number!,
      issueDate: fromDbDate(invoice.issueDate),
      contactName: invoice.contact.name,
      contactTaxId: invoice.contact.taxId,
      referenceNo: invoice.referenceNo,
      subtotalMinor: invoice.subtotalMinor.toString(),
      vatMinor: invoice.vatMinor.toString(),
      vatRecoverable: invoice.vatRecoverable,
    }));

    return {
      from: query.from,
      to: query.to,
      currency: business.baseCurrency,
      registered: (settings as { vatRegistered?: boolean }).vatRegistered === true,
      output: outputSide,
      input: inputSide,
      netMinor: (BigInt(outputSide.vatMinor) - BigInt(inputSide.vatMinor)).toString(),
      documents,
    };
  });

export const vatService = { summary };
