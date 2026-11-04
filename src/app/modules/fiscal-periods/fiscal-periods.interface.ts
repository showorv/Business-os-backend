import type { z } from "zod";
import type { fiscalPeriodsValidation } from "./fiscal-periods.validation.js";

export type IPeriodParams = z.infer<typeof fiscalPeriodsValidation.periodParams>;
export type IYearParams = z.infer<typeof fiscalPeriodsValidation.yearParams>;
export type ICreateYearBody = z.infer<typeof fiscalPeriodsValidation.createYear>;
export type IChangePeriodStatusBody = z.infer<typeof fiscalPeriodsValidation.changeStatus>;
export type IListPeriodsQuery = z.infer<typeof fiscalPeriodsValidation.listQuery>;

export interface FiscalActor {
  workspaceId: string;
  businessId: string;
  fiscalYearStartMonth: number;
}

export interface PeriodRules {
  // Admins may still post into a soft-closed period.
  allowSoftClosed?: boolean;
  // Opening balances may be dated before the first fiscal year.
  allowBackfill?: boolean;
}
