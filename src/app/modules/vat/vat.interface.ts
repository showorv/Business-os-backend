import type { z } from "zod";
import type { vatValidation } from "./vat.validation.js";

export type IVatSummaryQuery = z.infer<typeof vatValidation.summaryQuery>;

// Amounts in minor units, as strings.
export interface IVatRateRow {
  // 1500 is 15%. 0 is zero-rated or exempt.
  rateBp: number;
  taxableMinor: string;
  vatMinor: string;
}

export interface IVatSide {
  rows: IVatRateRow[];
  taxableMinor: string;
  vatMinor: string;
  documents: number;
}

export interface IVatDocument {
  invoiceId: string;
  kind: "SALE" | "BILL";
  number: string;
  issueDate: string;
  contactName: string;
  contactTaxId: string | null;
  referenceNo: string | null;
  subtotalMinor: string;
  vatMinor: string;
  // A bill whose VAT can't be claimed back (the business wasn't VAT-registered when it was recorded).
  vatRecoverable: boolean;
}

export interface IVatSummary {
  from: string;
  to: string;
  currency: string;
  registered: boolean;
  // VAT charged on sales.
  output: IVatSide;
  // VAT paid on purchases that can be claimed back.
  input: IVatSide;
  // Output less input: above zero is owed to NBR, below zero carries forward.
  netMinor: string;
  documents: IVatDocument[];
}
