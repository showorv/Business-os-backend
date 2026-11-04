import { z } from "zod";
import { fiscalPeriodsValidation } from "../modules/fiscal-periods/fiscal-periods.validation.js";
import { journalsValidation } from "../modules/journals/journals.validation.js";
import { ledgerAccountsValidation } from "../modules/ledger-accounts/ledger-accounts.validation.js";
import { reconciliationsValidation } from "../modules/reconciliations/reconciliations.validation.js";
import { reportsValidation } from "../modules/reports/reports.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const ledgerParams = businessParams.extend(ledgerAccountsValidation.ledgerAccountParams.shape);
const periodParams = businessParams.extend(fiscalPeriodsValidation.periodParams.shape);
const yearParams = businessParams.extend(fiscalPeriodsValidation.yearParams.shape);
const journalParams = businessParams.extend(journalsValidation.journalParams.shape);
const reconciliationParams = businessParams.extend(reconciliationsValidation.reconciliationParams.shape);
const reconciliationLineParams = businessParams.extend(reconciliationsValidation.lineParams.shape);

const ledgerAccount = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  nameBn: z.string().nullable(),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
  normalBalance: z.enum(["DEBIT", "CREDIT"]),
  cashFlowClass: z.enum(["OPERATING", "INVESTING", "FINANCING"]),
  parentId: z.uuid().nullable(),
  isSystem: z.boolean(),
  isActive: z.boolean(),
});

const period = z.object({
  id: z.uuid(),
  fiscalYear: z.number(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.enum(["OPEN", "SOFT_CLOSED", "CLOSED"]),
});

const journal = z.object({
  id: z.uuid(),
  entryNo: z.string(),
  entryDate: z.string(),
  kind: z.enum(["STANDARD", "REVERSAL", "ADJUSTING", "CLOSING", "OPENING"]),
  reversesId: z.uuid().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.uuid().nullable(),
  memo: z.string().nullable(),
});

const journalLine = z.object({
  id: z.uuid(),
  lineNo: z.number(),
  debitMinor: z.string(),
  creditMinor: z.string(),
  currency: z.string(),
  memo: z.string().nullable(),
  ledgerAccount: z.object({ id: z.uuid(), code: z.string(), name: z.string(), nameBn: z.string().nullable(), type: z.string() }),
});

const reconciliation = z.object({
  id: z.uuid(),
  financialAccountId: z.uuid(),
  statementDate: z.string(),
  statementBalanceMinor: z.string(),
  status: z.enum(["OPEN", "CLOSED"]),
  bookBalanceMinor: z.string().nullable(),
  differenceMinor: z.string().nullable(),
  adjustmentEntryId: z.uuid().nullable(),
});

const reportLine = z.object({ ledgerAccountId: z.uuid(), code: z.string(), name: z.string(), nameBn: z.string().nullable(), amountMinor: z.string() });
const reportSection = z.object({ items: z.array(reportLine), totalMinor: z.string() });
const reportBasis = { currency: z.string(), basis: z.literal("POSTED_ACTUALS") };

const ledgerAccounts = "/businesses/{businessId}/ledger-accounts";
const periods = "/businesses/{businessId}/fiscal-periods";
const journals = "/businesses/{businessId}/journals";
const reports = "/businesses/{businessId}/reports";
const reconciliations = "/businesses/{businessId}/reconciliations";

addPath("Chart of accounts", { method: "get", path: ledgerAccounts, summary: "List accounts by code. Needs finance.read", params: businessParams, query: ledgerAccountsValidation.listQuery, response: z.array(ledgerAccount) });
addPath("Chart of accounts", { method: "post", path: ledgerAccounts, summary: "Add an account. Needs ledger.post", params: businessParams, body: ledgerAccountsValidation.create, response: ledgerAccount, status: 201 });
addPath("Chart of accounts", { method: "patch", path: `${ledgerAccounts}/{ledgerAccountId}`, summary: "Rename, re-parent or deactivate. Needs ledger.post", params: ledgerParams, body: ledgerAccountsValidation.update, response: ledgerAccount });

addPath("Fiscal periods", { method: "get", path: periods, summary: "List periods. Needs finance.read", params: businessParams, query: fiscalPeriodsValidation.listQuery, response: z.array(period) });
addPath("Fiscal periods", { method: "post", path: `${periods}/years`, summary: "Open a fiscal year's 12 periods. Needs period.close", params: businessParams, body: fiscalPeriodsValidation.createYear, response: z.array(period), status: 201 });
addPath("Fiscal periods", { method: "post", path: `${periods}/{periodId}/status`, summary: "Soft-close, close or reopen. Needs period.close and recent MFA", params: periodParams, body: fiscalPeriodsValidation.changeStatus, response: period });
addPath("Fiscal periods", { method: "post", path: `${periods}/years/{fiscalYear}/close`, summary: "Year-end close: moves profit to Retained Earnings. Needs period.close and recent MFA", params: yearParams, response: z.object({ fiscalYear: z.number(), netProfitMinor: z.string(), closingEntryNo: z.string().nullable() }) });

addPath("Journals", { method: "post", path: journals, summary: "Post a manual journal. Send Idempotency-Key to make retries safe. Needs ledger.post", params: businessParams, body: journalsValidation.create, response: journal, status: 201, idempotent: true });
addPath("Journals", { method: "get", path: journals, summary: "List journals with filters. Needs finance.read", params: businessParams, query: journalsValidation.listQuery, response: z.array(journal) });
addPath("Journals", { method: "get", path: `${journals}/{journalId}`, summary: "Get a journal with its debit and credit lines. Needs finance.read", params: journalParams, response: journal.extend({ lines: z.array(journalLine) }) });
addPath("Journals", { method: "post", path: `${journals}/{journalId}/reverse`, summary: "Reverse a manual journal. Needs ledger.reverse", params: journalParams, body: journalsValidation.reverse, response: journal, status: 201 });

addPath("Reports", { method: "get", path: `${reports}/trial-balance`, summary: "Balance of every account at a date. Needs finance.read", params: businessParams, query: reportsValidation.asOfQuery, response: z.object({ ...reportBasis, asOf: z.string(), items: z.array(reportLine.omit({ amountMinor: true }).extend({ type: z.string(), debitBalanceMinor: z.string(), creditBalanceMinor: z.string() })), totalDebitMinor: z.string(), totalCreditMinor: z.string(), balanced: z.boolean() }) });
addPath("Reports", { method: "get", path: `${reports}/profit-and-loss`, summary: "Revenue minus expenses for a date range. Needs finance.read", params: businessParams, query: reportsValidation.rangeQuery, response: z.object({ ...reportBasis, from: z.string(), to: z.string(), revenue: reportSection, expenses: reportSection, netProfitMinor: z.string() }) });
addPath("Reports", { method: "get", path: `${reports}/balance-sheet`, summary: "Assets, liabilities and equity at a date. Needs finance.read", params: businessParams, query: reportsValidation.asOfQuery, response: z.object({ ...reportBasis, asOf: z.string(), assets: reportSection, liabilities: reportSection, equity: reportSection.extend({ unclosedProfitMinor: z.string() }), balanced: z.boolean() }) });
addPath("Reports", { method: "get", path: `${reports}/cash-flow`, summary: "Cash in and out by activity, direct method. Needs finance.read", params: businessParams, query: reportsValidation.rangeQuery, response: z.object({ ...reportBasis, from: z.string(), to: z.string(), beginningCashMinor: z.string(), openingBalancesMinor: z.string(), operating: reportSection, investing: reportSection, financing: reportSection, netChangeMinor: z.string(), endingCashMinor: z.string(), balanced: z.boolean() }) });

addPath("Reconciliation", { method: "post", path: reconciliations, summary: "Start reconciling an account against a statement. Needs ledger.post", params: businessParams, body: reconciliationsValidation.create, response: reconciliation, status: 201 });
addPath("Reconciliation", { method: "get", path: reconciliations, summary: "List reconciliations. Needs finance.read", params: businessParams, query: reconciliationsValidation.listQuery, response: z.array(reconciliation) });
addPath("Reconciliation", { method: "get", path: `${reconciliations}/{reconciliationId}`, summary: "Current difference and the lines still unmatched. Needs finance.read", params: reconciliationParams });
addPath("Reconciliation", { method: "post", path: `${reconciliations}/{reconciliationId}/lines`, summary: "Match journal lines to the statement. Needs ledger.post", params: reconciliationParams, body: reconciliationsValidation.matchLines });
addPath("Reconciliation", { method: "delete", path: `${reconciliations}/{reconciliationId}/lines/{journalLineId}`, summary: "Un-match a line. Needs ledger.post", params: reconciliationLineParams });
addPath("Reconciliation", { method: "post", path: `${reconciliations}/{reconciliationId}/close`, summary: "Close at zero difference, or with adjust: true (needs transactions.approve). Needs ledger.post", params: reconciliationParams, body: reconciliationsValidation.close, response: reconciliation });
