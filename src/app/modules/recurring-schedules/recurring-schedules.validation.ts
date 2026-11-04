import { z } from "zod";
import { dateField } from "../../utils/dates.js";
import { minorAmountField, positiveMinorAmountField } from "../../utils/money.js";
import { paginationQuery } from "../../utils/pagination.js";
import { scheduleRuleField } from "../../utils/rrule.js";
import { textField, timezoneField } from "../../utils/validationFields.js";

const MAX_REMIND_DAYS = 60;

const scheduleParams = z.object({ scheduleId: z.uuid() });

const create = z.object({
  name: textField(120),
  // SALARY is an expense against the Salaries category. It needs no type or category of its own.
  kind: z.enum(["TRANSACTION", "SALARY"]).default("TRANSACTION"),
  type: z.enum(["INCOME", "EXPENSE", "TRANSFER"]).optional(),
  rrule: scheduleRuleField,
  startDate: dateField,
  timezone: timezoneField.optional(),
  accountId: z.uuid(),
  toAccountId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  amountMinor: positiveMinorAmountField,
  feeMinor: minorAmountField.default("0"),
  description: textField(1000).optional(),
  autoPost: z.boolean().default(false),
  // Leave out for no reminder.
  remindDaysBefore: z.number().int().min(0).max(MAX_REMIND_DAYS).optional(),
});

const update = z
  .object({
    name: textField(120),
    rrule: scheduleRuleField,
    accountId: z.uuid(),
    toAccountId: z.uuid().nullable(),
    categoryId: z.uuid().nullable(),
    amountMinor: positiveMinorAmountField,
    feeMinor: minorAmountField,
    description: textField(1000).nullable(),
    autoPost: z.boolean(),
    remindDaysBefore: z.number().int().min(0).max(MAX_REMIND_DAYS).nullable(),
    status: z.enum(["ACTIVE", "PAUSED", "ENDED"]),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const listQuery = z.object({
  ...paginationQuery,
  status: z.enum(["ACTIVE", "PAUSED", "ENDED"]).optional(),
  kind: z.enum(["TRANSACTION", "SALARY"]).optional(),
});

export const recurringSchedulesValidation = { scheduleParams, create, update, listQuery };
