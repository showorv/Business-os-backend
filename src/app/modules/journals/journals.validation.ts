import { z } from "zod";
import { dateField } from "../../utils/dates.js";
import { minorAmountField } from "../../utils/money.js";
import { paginationQuery } from "../../utils/pagination.js";
import { textField } from "../../utils/validationFields.js";

const journalParams = z.object({ journalId: z.uuid() });

const line = z
  .object({
    ledgerAccountId: z.uuid(),
    debitMinor: minorAmountField.default("0"),
    creditMinor: minorAmountField.default("0"),
    memo: textField(255).optional(),
  })
  .refine((value) => (BigInt(value.debitMinor) === 0n) !== (BigInt(value.creditMinor) === 0n), {
    message: "LINE_NEEDS_ONE_SIDE",
  });

// OPENING, CLOSING and REVERSAL entries are only made by the system.
const create = z.object({
  entryDate: dateField,
  kind: z.enum(["STANDARD", "ADJUSTING"]).default("ADJUSTING"),
  memo: textField(500),
  lines: z.array(line).min(2).max(200),
});

const reverse = z.object({
  entryDate: dateField.optional(),
  memo: textField(500).optional(),
});

const listQuery = z.object({
  ...paginationQuery,
  kind: z.enum(["STANDARD", "REVERSAL", "ADJUSTING", "CLOSING", "OPENING"]).optional(),
  ledgerAccountId: z.uuid().optional(),
  from: dateField.optional(),
  to: dateField.optional(),
});

export const journalsValidation = { journalParams, create, reverse, listQuery };
