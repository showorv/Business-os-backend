import { z } from "zod";
import { vatValidation } from "../modules/vat/vat.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });

const side = z.object({
  rows: z.array(z.object({ rateBp: z.number().int(), taxableMinor: z.string(), vatMinor: z.string() })),
  taxableMinor: z.string(),
  vatMinor: z.string(),
  documents: z.number().int(),
});

const summary = z.object({
  from: z.string(),
  to: z.string(),
  currency: z.string(),
  registered: z.boolean(),
  output: side,
  input: side,
  netMinor: z.string(),
  documents: z.array(
    z.object({
      invoiceId: z.uuid(),
      kind: z.enum(["SALE", "BILL"]),
      number: z.string(),
      issueDate: z.string(),
      contactName: z.string(),
      contactTaxId: z.string().nullable(),
      referenceNo: z.string().nullable(),
      subtotalMinor: z.string(),
      vatMinor: z.string(),
      vatRecoverable: z.boolean(),
    }),
  ),
});

addPath("VAT", {
  method: "get",
  path: "/businesses/{businessId}/vat/summary",
  summary: "VAT on sales (output) and claimable VAT on bills (input) for a period, by rate, with the invoices and bills behind it. Help for the monthly return, not the return itself. Needs finance.read",
  params: businessParams,
  query: vatValidation.summaryQuery,
  response: summary,
});
