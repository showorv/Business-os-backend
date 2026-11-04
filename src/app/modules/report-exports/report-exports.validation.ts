import { z } from "zod";
import { dateField } from "../../utils/dates.js";

const exportParams = z.object({ exportId: z.uuid() });

const AS_OF_REPORTS = ["TRIAL_BALANCE", "BALANCE_SHEET"];

const create = z
  .object({
    report: z.enum(["TRIAL_BALANCE", "PROFIT_AND_LOSS", "BALANCE_SHEET", "CASH_FLOW"]),
    format: z.enum(["PDF", "XLSX", "CSV"]),
    asOf: dateField.optional(),
    from: dateField.optional(),
    to: dateField.optional(),
    // Defaults to the language and digit style on your profile.
    locale: z.enum(["en", "bn-BD"]).optional(),
    digitStyle: z.enum(["latin", "bangla"]).optional(),
  })
  .refine((body) => (AS_OF_REPORTS.includes(body.report) ? !!body.asOf : !!body.from && !!body.to), {
    message: "REPORT_DATES_REQUIRED",
  });

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export const reportExportsValidation = { exportParams, create, listQuery };
