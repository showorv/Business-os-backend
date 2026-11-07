import type { z } from "zod";
import type { invoicesValidation } from "./invoices.validation.js";

export type IInvoiceParams = z.infer<typeof invoicesValidation.invoiceParams>;
export type IPaymentParams = z.infer<typeof invoicesValidation.paymentParams>;
export type ICreateInvoiceBody = z.infer<typeof invoicesValidation.create>;
export type IUpdateInvoiceBody = z.infer<typeof invoicesValidation.update>;
export type IListInvoicesQuery = z.infer<typeof invoicesValidation.listQuery>;
export type IRecordPaymentBody = z.infer<typeof invoicesValidation.recordPayment>;
export type IVoidInvoiceBody = z.infer<typeof invoicesValidation.voidBody>;
export type IEmailInvoiceBody = z.infer<typeof invoicesValidation.email>;
export type IAgingQuery = z.infer<typeof invoicesValidation.agingQuery>;
export type IInvoicePdfQuery = z.infer<typeof invoicesValidation.pdfQuery>;
export type IInvoiceLineInput = ICreateInvoiceBody["lines"][number];

// Days past the due date. "current" is not due yet.
export const AGING_BUCKETS = ["current", "days1to30", "days31to60", "days61to90", "over90"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

// Amounts still due, in minor units as strings.
export type IAgingAmounts = Record<AgingBucket, string> & { totalMinor: string };

export interface IAgingRow extends IAgingAmounts {
  contactId: string;
  contactName: string;
  invoices: number;
  oldestDueDate: string;
}

export interface IAgingReport {
  kind: "SALE" | "BILL";
  asOf: string;
  currency: string;
  totals: IAgingAmounts;
  rows: IAgingRow[];
}
