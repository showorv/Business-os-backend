import { z } from "zod";
import { dateField, monthField } from "../../utils/dates.js";
import { positiveMinorAmountField } from "../../utils/money.js";
import { currencyField, textField } from "../../utils/validationFields.js";

// There is no list of businesses here on purpose: the server works out which ones you may see.
const dashboardQuery = z.object({
  fromMonth: monthField,
  toMonth: monthField,
  reportingCurrency: currencyField.optional(),
  includeArchived: z.stringbool().default(false),
});

const createTransfer = z
  .object({
    fromBusinessId: z.uuid(),
    fromAccountId: z.uuid(),
    toBusinessId: z.uuid(),
    toAccountId: z.uuid(),
    amountMinor: positiveMinorAmountField,
    transferDate: dateField,
    memo: textField(500).optional(),
  })
  .refine((body) => body.fromBusinessId !== body.toBusinessId, { message: "BUSINESSES_MUST_DIFFER" });

export const consolidatedValidation = { dashboardQuery, createTransfer };
