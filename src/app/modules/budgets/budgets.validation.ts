import { z } from "zod";
import { monthField } from "../../utils/dates.js";
import { positiveMinorAmountField } from "../../utils/money.js";
import { textField } from "../../utils/validationFields.js";

const budgetParams = z.object({ budgetId: z.uuid() });

const line = z.object({
  categoryId: z.uuid(),
  amountMinor: positiveMinorAmountField,
  alertPercent: z.number().int().min(1).max(100).default(80),
});

const create = z.object({
  name: textField(120),
  startMonth: monthField,
  endMonth: monthField,
  lines: z.array(line).min(1).max(200),
});

const update = z
  .object({ name: textField(120), status: z.enum(["ACTIVE", "ARCHIVED"]) })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const listQuery = z.object({ includeArchived: z.stringbool().default(false) });

export const budgetsValidation = { budgetParams, line, create, update, listQuery };
