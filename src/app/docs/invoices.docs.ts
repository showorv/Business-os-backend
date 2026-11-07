import { z } from "zod";
import { invoicesValidation } from "../modules/invoices/invoices.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const invoiceParams = businessParams.extend(invoicesValidation.invoiceParams.shape);
const paymentParams = businessParams.extend(invoicesValidation.paymentParams.shape);
const invoices = "/businesses/{businessId}/invoices";

const status = invoicesValidation.invoiceStatus;

const line = z.object({
  id: z.uuid(),
  lineNo: z.number().int(),
  description: z.string(),
  quantity: z.string(),
  unitPriceMinor: z.string(),
  amountMinor: z.string(),
  categoryId: z.uuid(),
  category: z.object({ id: z.uuid(), name: z.string(), nameBn: z.string().nullable() }),
});

const payment = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  account: z.object({ id: z.uuid(), name: z.string() }),
  paidOn: z.string(),
  amountMinor: z.string(),
  note: z.string().nullable(),
  journalEntryId: z.uuid(),
  voidedAt: z.string().nullable(),
  reversalJournalId: z.uuid().nullable(),
  createdAt: z.string(),
});

const summaryFields = {
  id: z.uuid(),
  kind: invoicesValidation.invoiceKind,
  number: z.string().nullable(),
  status,
  contactId: z.uuid(),
  issueDate: z.string(),
  dueDate: z.string(),
  currency: z.string(),
  totalMinor: z.string(),
  paidMinor: z.string(),
  // What is still owed: total less paid, 0 once void.
  dueMinor: z.string(),
  isOverdue: z.boolean(),
  referenceNo: z.string().nullable(),
  notes: z.string().nullable(),
  journalEntryId: z.uuid().nullable(),
  issuedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  emailedAt: z.string().nullable(),
  createdAt: z.string(),
};

const invoiceSummary = z.object({ ...summaryFields, contact: z.object({ id: z.uuid(), name: z.string() }) });

export const invoice = z.object({
  ...summaryFields,
  contact: z.object({
    id: z.uuid(),
    kind: z.enum(["CUSTOMER", "SUPPLIER", "BOTH"]),
    name: z.string(),
    company: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    address: z.string().nullable(),
    taxId: z.string().nullable(),
  }),
  lines: z.array(line),
  payments: z.array(payment),
});

const amounts = {
  current: z.string(),
  days1to30: z.string(),
  days31to60: z.string(),
  days61to90: z.string(),
  over90: z.string(),
  totalMinor: z.string(),
};

const agingReport = z.object({
  kind: invoicesValidation.invoiceKind,
  asOf: z.string(),
  currency: z.string(),
  totals: z.object(amounts),
  rows: z.array(z.object({ contactId: z.uuid(), contactName: z.string(), invoices: z.number().int(), oldestDueDate: z.string(), ...amounts })),
});

const T = "Invoices and bills";
addPath(T, {
  method: "post",
  path: invoices,
  summary: "Make an invoice (kind SALE, for a customer) or a bill (kind BILL, from a supplier) as a draft, or issue it at once with issue: true. Needs finance.write",
  params: businessParams,
  body: invoicesValidation.create,
  response: invoice,
  status: 201,
});
addPath(T, { method: "get", path: invoices, summary: "Invoices or bills, newest first. overdue=true lists open ones past their due date. Needs finance.read", params: businessParams, query: invoicesValidation.listQuery, response: z.array(invoiceSummary) });
addPath(T, {
  method: "get",
  path: `${invoices}/aging`,
  summary: "Baki: what is still owed on open invoices (or bills), per contact, by days past due. Needs finance.read",
  params: businessParams,
  query: invoicesValidation.agingQuery,
  response: agingReport,
});
addPath(T, { method: "get", path: `${invoices}/{invoiceId}`, summary: "One invoice or bill, with its lines and payments. Needs finance.read", params: invoiceParams, response: invoice });
addPath(T, { method: "patch", path: `${invoices}/{invoiceId}`, summary: "Change a draft. Sending lines replaces them all. Needs finance.write", params: invoiceParams, body: invoicesValidation.update, response: invoice });
addPath(T, { method: "delete", path: `${invoices}/{invoiceId}`, summary: "Delete a draft. Issued ones are voided instead. Needs finance.write", params: invoiceParams, status: 204 });
addPath(T, {
  method: "post",
  path: `${invoices}/{invoiceId}/issue`,
  summary: "Issue a draft: gives it a number and posts it (receivables or payables against the line categories). Needs finance.write",
  params: invoiceParams,
  response: invoice,
});
addPath(T, { method: "post", path: `${invoices}/{invoiceId}/void`, summary: "Void an issued invoice with no payments; its journal is reversed. Needs finance.write", params: invoiceParams, body: invoicesValidation.voidBody, response: invoice });
addPath(T, {
  method: "post",
  path: `${invoices}/{invoiceId}/payments`,
  summary: "Record money received for an invoice, or paid for a bill, up to what is due. Needs finance.write",
  params: invoiceParams,
  body: invoicesValidation.recordPayment,
  response: invoice,
  status: 201,
});
addPath(T, { method: "post", path: `${invoices}/{invoiceId}/payments/{paymentId}/void`, summary: "Undo a payment entered by mistake; its journal is reversed. Needs finance.write", params: paymentParams, response: invoice });
addPath(T, { method: "get", path: `${invoices}/{invoiceId}/pdf`, summary: "The invoice or bill as a PDF file (application/pdf, not JSON). Needs finance.read", params: invoiceParams, query: invoicesValidation.pdfQuery });
addPath(T, {
  method: "post",
  path: `${invoices}/{invoiceId}/email`,
  summary: "Email an issued sales invoice, with its PDF, to the customer (or to `to`). Needs finance.write and SMTP on the server",
  params: invoiceParams,
  body: invoicesValidation.email,
  response: invoice,
});
