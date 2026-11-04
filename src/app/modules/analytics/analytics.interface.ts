import type { z } from "zod";
import type { analyticsValidation } from "./analytics.validation.js";

export type IDashboardQuery = z.infer<typeof analyticsValidation.dashboardQuery>;
export type ICompareQuery = z.infer<typeof analyticsValidation.compareQuery>;

export interface BusinessFigures {
  revenueMinor: bigint;
  expensesMinor: bigint;
  netProfitMinor: bigint;
  cashBalanceMinor: bigint;
  receivableMinor: bigint;
  payableMinor: bigint;
  assetsMinor: bigint;
  liabilitiesMinor: bigint;
}
