import { z } from "zod";
import { dateField } from "../../utils/dates.js";
import { minorAmountField, positiveMinorAmountField } from "../../utils/money.js";
import { paginationQuery } from "../../utils/pagination.js";
import { currencyField, textField } from "../../utils/validationFields.js";

const transactionType = z.enum(["INCOME", "EXPENSE", "TRANSFER", "REFUND", "ADJUSTMENT"]);

const transactionParams = z.object({ transactionId: z.uuid() });
const attachmentParams = transactionParams.extend({ documentId: z.uuid() });

// These check each field's format. Rules that span fields live in transactions.service.ts, so
// create and update share them.
const create = z.object({
  type: transactionType,
  accountId: z.uuid(),
  toAccountId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  // The customer or supplier. Can also be set or changed after posting.
  contactId: z.uuid().optional(),
  amountMinor: positiveMinorAmountField,
  feeMinor: minorAmountField.default("0"),
  currency: currencyField.optional(),
  txnDate: dateField,
  paymentMethod: textField(50).optional(),
  referenceNo: textField(100).optional(),
  description: textField(1000).optional(),
  // Create and post in one request. Needs ledger.post as well as finance.write.
  postNow: z.boolean().default(false),
});

// `type` is left out: to change it, void the draft and create a new one.
const update = z
  .object({
    accountId: z.uuid(),
    toAccountId: z.uuid().nullable(),
    categoryId: z.uuid().nullable(),
    contactId: z.uuid().nullable(),
    amountMinor: positiveMinorAmountField,
    feeMinor: minorAmountField,
    txnDate: dateField,
    paymentMethod: textField(50).nullable(),
    referenceNo: textField(100).nullable(),
    description: textField(1000).nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const listQuery = z.object({
  ...paginationQuery,
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "POSTED", "REJECTED", "VOID"]).optional(),
  type: transactionType.optional(),
  accountId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  from: dateField.optional(),
  to: dateField.optional(),
  possibleDuplicate: z.stringbool().optional(),
});

const attach = z.object({ documentId: z.uuid() });

// Which customer or supplier a transaction was with. Doesn't touch the books, so any status but VOID.
const setContact = z.object({ contactId: z.uuid().nullable() });

const reverse = z.object({
  entryDate: dateField.optional(),
  memo: textField(500).optional(),
});

export const transactionsValidation = { transactionParams, attachmentParams, create, update, listQuery, attach, setContact, reverse };
