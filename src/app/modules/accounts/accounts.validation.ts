import { z } from "zod";
import { dateField } from "../../utils/dates.js";
import { minorAmountField } from "../../utils/money.js";
import { normalizeDigits } from "../../utils/normalize.js";
import { paginationQuery } from "../../utils/pagination.js";
import { currencyField, textField } from "../../utils/validationFields.js";

const accountParams = z.object({ accountId: z.uuid() });

// A bank number or bKash phone. Only its last 4 digits are ever stored.
const accountNumberField = z
  .string()
  .overwrite(normalizeDigits)
  .trim()
  .regex(/^[\d\s+-]{4,34}$/);

const create = z.object({
  name: textField(120),
  type: z.enum(["CASH", "BANK", "BKASH", "NAGAD", "MFS_OTHER", "CUSTOM"]),
  currency: currencyField.optional(),
  openingBalanceMinor: minorAmountField.default("0"),
  openingDate: dateField.optional(),
  accountNumber: accountNumberField.optional(),
});

// The opening balance is left out: from Phase 4 it is a posted journal, so it cannot just be edited.
const update = z
  .object({
    name: textField(120),
    accountNumber: accountNumberField.nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const listQuery = z.object({
  ...paginationQuery,
  includeInactive: z.stringbool().default(false),
});

export const accountsValidation = { accountParams, create, update, listQuery };
