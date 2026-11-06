import { z } from "zod";
import { accountsValidation } from "../modules/accounts/accounts.validation.js";
import { categoriesValidation } from "../modules/categories/categories.validation.js";
import { transactionsValidation } from "../modules/transactions/transactions.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const accountParams = businessParams.extend(accountsValidation.accountParams.shape);
const categoryParams = businessParams.extend(categoriesValidation.categoryParams.shape);
const transactionParams = businessParams.extend(transactionsValidation.transactionParams.shape);
const attachmentParams = businessParams.extend(transactionsValidation.attachmentParams.shape);

// Amounts are strings of digits, in minor units (paisa for BDT).
const account = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.string(),
  currency: z.string(),
  openingBalanceMinor: z.string(),
  openingDate: z.string(),
  currentBalanceMinor: z.string(),
  maskedNumber: z.string().nullable(),
  isActive: z.boolean(),
});

const category = z.object({
  id: z.uuid(),
  type: z.enum(["INCOME", "EXPENSE"]),
  name: z.string(),
  nameBn: z.string().nullable(),
  isSystem: z.boolean(),
  isActive: z.boolean(),
});

const transaction = z.object({
  id: z.uuid(),
  number: z.string(),
  type: z.string(),
  status: z.string(),
  accountId: z.uuid(),
  toAccountId: z.uuid().nullable(),
  categoryId: z.uuid().nullable(),
  amountMinor: z.string(),
  feeMinor: z.string(),
  currency: z.string(),
  txnDate: z.string(),
  paymentMethod: z.string().nullable(),
  referenceNo: z.string().nullable(),
  description: z.string().nullable(),
  source: z.string(),
  possibleDuplicate: z.boolean(),
  duplicateOfId: z.uuid().nullable(),
  journalEntryId: z.uuid().nullable(),
  reversalEntryId: z.uuid().nullable(),
  approvedBy: z.uuid().nullable(),
  approvedAt: z.string().nullable(),
  createdBy: z.uuid(),
  createdAt: z.string(),
});

const accounts = "/businesses/{businessId}/accounts";
const categories = "/businesses/{businessId}/categories";
const transactions = "/businesses/{businessId}/transactions";

addPath("Accounts", { method: "post", path: accounts, summary: "Create a financial account. Needs finance.write", params: businessParams, body: accountsValidation.create, response: account, status: 201 });
addPath("Accounts", { method: "get", path: accounts, summary: "List accounts. Needs finance.read", params: businessParams, query: accountsValidation.listQuery, response: z.array(account) });
addPath("Accounts", { method: "get", path: `${accounts}/{accountId}`, summary: "Get one account. Needs finance.read", params: accountParams, response: account });
addPath("Accounts", { method: "patch", path: `${accounts}/{accountId}`, summary: "Rename, change the number, or deactivate. Needs finance.write", params: accountParams, body: accountsValidation.update, response: account });

addPath("Categories", { method: "post", path: categories, summary: "Create a category. Needs finance.write", params: businessParams, body: categoriesValidation.create, response: category, status: 201 });
addPath("Categories", { method: "get", path: categories, summary: "List categories. Needs finance.read", params: businessParams, query: categoriesValidation.listQuery, response: z.array(category) });
addPath("Categories", { method: "patch", path: `${categories}/{categoryId}`, summary: "Rename or deactivate. Needs finance.write", params: categoryParams, body: categoriesValidation.update, response: category });

addPath("Transactions", { method: "post", path: transactions, summary: "Create a draft. Send Idempotency-Key to make retries safe. Needs finance.write", params: businessParams, body: transactionsValidation.create, response: transaction, status: 201, idempotent: true });
addPath("Transactions", { method: "get", path: transactions, summary: "List with filters, newest date first. Needs finance.read", params: businessParams, query: transactionsValidation.listQuery, response: z.array(transaction) });
addPath("Transactions", { method: "get", path: `${transactions}/{transactionId}`, summary: "Get one, with attachments. Needs finance.read", params: transactionParams, response: transaction.extend({ attachments: z.array(z.object({ documentId: z.uuid(), createdAt: z.string(), fileName: z.string(), mime: z.string(), sizeBytes: z.number().int() })) }) });
addPath("Transactions", { method: "patch", path: `${transactions}/{transactionId}`, summary: "Edit a draft. Needs finance.write", params: transactionParams, body: transactionsValidation.update, response: transaction });
addPath("Transactions", { method: "post", path: `${transactions}/{transactionId}/void`, summary: "Void a draft. It is kept, not deleted. Needs finance.write", params: transactionParams, response: transaction });
addPath("Transactions", { method: "post", path: `${transactions}/{transactionId}/post`, summary: "Post a draft to the ledger, or send it for approval if above the threshold. Needs ledger.post", params: transactionParams, response: transaction });
addPath("Transactions", { method: "post", path: `${transactions}/{transactionId}/approve`, summary: "Approve and post. Must be someone other than the creator. Needs transactions.approve", params: transactionParams, response: transaction });
addPath("Transactions", { method: "post", path: `${transactions}/{transactionId}/reject`, summary: "Reject a pending transaction. Needs transactions.approve", params: transactionParams, response: transaction });
addPath("Transactions", { method: "post", path: `${transactions}/{transactionId}/reverse`, summary: "Reverse a posted transaction with a mirror-image journal. Needs ledger.reverse", params: transactionParams, body: transactionsValidation.reverse, response: transaction });
addPath("Transactions", { method: "post", path: `${transactions}/{transactionId}/dismiss-duplicate`, summary: "Mark a flagged transaction as not a duplicate. Needs finance.write", params: transactionParams, response: transaction });
addPath("Transactions", { method: "post", path: `${transactions}/{transactionId}/attachments`, summary: "Attach an uploaded document. Needs finance.write", params: transactionParams, body: transactionsValidation.attach });
addPath("Transactions", { method: "delete", path: `${transactions}/{transactionId}/attachments/{documentId}`, summary: "Remove an attachment. Needs finance.write", params: attachmentParams });
