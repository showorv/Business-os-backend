import { z } from "zod";
import { monthField } from "../../utils/dates.js";

const dashboardQuery = z.object({
  fromMonth: monthField.optional(),
  toMonth: monthField.optional(),
});

const compareQuery = z.object({
  metric: z.enum(["REVENUE", "EXPENSES", "NET_PROFIT"]),
  fromMonth: monthField,
  toMonth: monthField,
  compareFromMonth: monthField,
  compareToMonth: monthField,
});

export const analyticsValidation = { dashboardQuery, compareQuery };
