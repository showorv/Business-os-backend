import { z } from "zod";
import { dateField } from "../../utils/dates.js";
import { positiveMinorAmountField } from "../../utils/money.js";
import { paginationQuery } from "../../utils/pagination.js";
import { textField } from "../../utils/validationFields.js";

const lineParams = z.object({ lineId: z.uuid() });

const listQuery = z.object({
  ...paginationQuery,
  status: z.enum(["UNMATCHED", "AWAITING_POSTING", "MATCHED", "IGNORED"]).optional(),
  financialAccountId: z.uuid().optional(),
  importId: z.uuid().optional(),
  connectionId: z.uuid().optional(),
  from: dateField.optional(),
  to: dateField.optional(),
});

const summaryQuery = z.object({ financialAccountId: z.uuid().optional() });

const match = z.object({ journalLineIds: z.array(z.uuid()).min(1).max(50) });

// Either a category (income or expense), or another of your accounts (a transfer).
const categorize = z
  .object({
    categoryId: z.uuid().optional(),
    transferAccountId: z.uuid().optional(),
    description: textField(1000).optional(),
    postNow: z.boolean().default(false),
  })
  .refine((body) => Boolean(body.categoryId) !== Boolean(body.transferAccountId), { message: "CATEGORY_OR_TRANSFER_REQUIRED" });

const split = z.object({
  parts: z
    .array(z.object({ categoryId: z.uuid(), amountMinor: positiveMinorAmountField, description: textField(1000).optional() }))
    .min(2)
    .max(20),
  postNow: z.boolean().default(false),
});

const runMatcher = z.object({ financialAccountId: z.uuid().optional() });

export const statementLinesValidation = { lineParams, listQuery, summaryQuery, match, categorize, split, runMatcher };
