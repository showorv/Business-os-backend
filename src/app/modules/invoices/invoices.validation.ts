import { z } from "zod";
import { dateField } from "../../utils/dates.js";
import { minorAmountField, positiveMinorAmountField } from "../../utils/money.js";
import { normalizeDigits } from "../../utils/normalize.js";
import { paginationQuery } from "../../utils/pagination.js";
import { emailField, textField } from "../../utils/validationFields.js";

const invoiceKind = z.enum(["SALE", "BILL"]);
const invoiceStatus = z.enum(["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"]);

const invoiceParams = z.object({ invoiceId: z.uuid() });
const paymentParams = invoiceParams.extend({ paymentId: z.uuid() });

// Up to three decimals, so 2.5 kg or 0.125 hours work. Bangla digits are accepted too.
const quantityField = z
  .string()
  .overwrite(normalizeDigits)
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, { abort: true })
  .refine((value) => Number(value) > 0, { message: "QUANTITY_MUST_BE_POSITIVE" });

const line = z.object({
  description: textField(300),
  quantity: quantityField,
  unitPriceMinor: minorAmountField,
  categoryId: z.uuid(),
  // VAT in basis points: 1500 is 15%, 750 is 7.5%. Prices are before VAT.
  vatRateBp: z.number().int().min(0).max(10000).default(0),
});

const fields = {
  contactId: z.uuid(),
  issueDate: dateField,
  dueDate: dateField,
  referenceNo: textField(60).nullable(),
  notes: textField(2000).nullable(),
  lines: z.array(line).min(1).max(100),
};

const dueNotBeforeIssue = (body: { issueDate?: string; dueDate?: string }) =>
  !body.issueDate || !body.dueDate || body.dueDate >= body.issueDate;

const create = z
  .object({
    kind: invoiceKind,
    contactId: fields.contactId,
    issueDate: fields.issueDate,
    dueDate: fields.dueDate,
    referenceNo: fields.referenceNo.optional(),
    notes: fields.notes.optional(),
    lines: fields.lines,
    // Issue straight away instead of keeping a draft.
    issue: z.boolean().default(false),
  })
  .refine(dueNotBeforeIssue, { message: "DUE_DATE_BEFORE_ISSUE_DATE", path: ["dueDate"] });

// Drafts only. Sending lines replaces all of them.
const update = z
  .object(fields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" })
  .refine(dueNotBeforeIssue, { message: "DUE_DATE_BEFORE_ISSUE_DATE", path: ["dueDate"] });

const listQuery = z.object({
  ...paginationQuery,
  kind: invoiceKind,
  status: invoiceStatus.optional(),
  // Issued or part-paid, past the due date.
  overdue: z.stringbool().default(false),
  contactId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(),
});

const recordPayment = z.object({
  accountId: z.uuid(),
  amountMinor: positiveMinorAmountField,
  paidOn: dateField,
  note: textField(300).optional(),
});

const voidBody = z.object({ reason: textField(300) });

const email = z.object({
  // Defaults to the customer's email.
  to: emailField.optional(),
  message: textField(2000).optional(),
});

const agingQuery = z.object({
  kind: invoiceKind,
  contactId: z.uuid().optional(),
  // Counted as of this day; defaults to today in the business's timezone.
  asOf: dateField.optional(),
});

const pdfQuery = z.object({ locale: z.enum(["en", "bn-BD"]).default("en") });

export const invoicesValidation = {
  invoiceKind,
  invoiceStatus,
  invoiceParams,
  paymentParams,
  create,
  update,
  listQuery,
  recordPayment,
  voidBody,
  email,
  agingQuery,
  pdfQuery,
};
