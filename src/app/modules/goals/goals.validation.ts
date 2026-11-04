import { z } from "zod";
import { monthField } from "../../utils/dates.js";
import { positiveMinorAmountField } from "../../utils/money.js";
import { textField } from "../../utils/validationFields.js";

const goalParams = z.object({ goalId: z.uuid() });

const create = z.object({
  name: textField(120),
  metric: z.enum(["REVENUE", "NET_PROFIT", "CASH_BALANCE"]),
  targetMinor: positiveMinorAmountField,
  startMonth: monthField,
  endMonth: monthField,
});

const update = z
  .object({ name: textField(120), targetMinor: positiveMinorAmountField, status: z.literal("CANCELLED") })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const listQuery = z.object({ status: z.enum(["ACTIVE", "ACHIEVED", "CANCELLED"]).optional() });

export const goalsValidation = { goalParams, create, update, listQuery };
