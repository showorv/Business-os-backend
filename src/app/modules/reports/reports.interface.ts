import type { z } from "zod";
import type { reportsValidation } from "./reports.validation.js";

export type IAsOfQuery = z.infer<typeof reportsValidation.asOfQuery>;
export type IRangeQuery = z.infer<typeof reportsValidation.rangeQuery>;

export interface AccountTotalRow {
  id: string;
  code: string;
  name: string;
  name_bn: string | null;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normal_balance: "DEBIT" | "CREDIT";
  debit: string;
  credit: string;
}

export interface LedgerCheck {
  businessId: string;
  unbalancedEntries: number;
  accountsOutOfStep: number;
  rollupsOutOfStep: number;
}
