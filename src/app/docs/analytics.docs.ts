import { z } from "zod";
import { analyticsValidation } from "../modules/analytics/analytics.validation.js";
import { budgetsValidation } from "../modules/budgets/budgets.validation.js";
import { consolidatedValidation } from "../modules/consolidated/consolidated.validation.js";
import { exchangeRatesValidation } from "../modules/exchange-rates/exchange-rates.validation.js";
import { goalsValidation } from "../modules/goals/goals.validation.js";
import { reportExportsValidation } from "../modules/report-exports/report-exports.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const budgetParams = businessParams.extend(budgetsValidation.budgetParams.shape);
const goalParams = businessParams.extend(goalsValidation.goalParams.shape);
const exportParams = businessParams.extend(reportExportsValidation.exportParams.shape);

const figures = z.object({
  revenueMinor: z.string(),
  expensesMinor: z.string(),
  netProfitMinor: z.string(),
  cashBalanceMinor: z.string(),
  receivableMinor: z.string(),
  payableMinor: z.string(),
  assetsMinor: z.string(),
  liabilitiesMinor: z.string(),
});

const dashboard = z.object({
  currency: z.string(),
  basis: z.literal("POSTED_ACTUALS"),
  fromMonth: z.string(),
  toMonth: z.string(),
  asOf: z.string(),
  revenueMinor: z.string(),
  expensesMinor: z.string(),
  netProfitMinor: z.string(),
  cashBalanceMinor: z.string(),
  receivableMinor: z.string(),
  payableMinor: z.string(),
  trend: z.array(z.object({ month: z.string(), revenueMinor: z.string(), expensesMinor: z.string(), netProfitMinor: z.string() })),
  topExpenses: z.array(z.object({ ledgerAccountId: z.uuid(), code: z.string(), name: z.string(), nameBn: z.string().nullable(), amountMinor: z.string(), sharePercent: z.string().nullable() })),
  accounts: z.array(z.object({ id: z.uuid(), name: z.string(), type: z.string(), currency: z.string(), currentBalanceMinor: z.string() })),
});

const budgetSummary = z.object({ id: z.uuid(), name: z.string(), startMonth: z.string(), endMonth: z.string(), status: z.enum(["ACTIVE", "ARCHIVED"]) });

const budgetLine = z.object({
  id: z.uuid(),
  category: z.object({ id: z.uuid(), name: z.string(), nameBn: z.string().nullable(), type: z.string() }),
  amountMinor: z.string(),
  alertPercent: z.number(),
  actualMinor: z.string(),
  remainingMinor: z.string(),
  usedPercent: z.string().nullable(),
  level: z.enum(["OK", "NEAR", "REACHED", "OVER"]),
  alerts: z.array(z.object({ percent: z.number(), actualMinor: z.string(), createdAt: z.string() })),
});

const comparePeriod = z.object({ fromMonth: z.string(), toMonth: z.string(), amountMinor: z.string() });

const goal = z.object({
  id: z.uuid(),
  name: z.string(),
  metric: z.enum(["REVENUE", "NET_PROFIT", "CASH_BALANCE"]),
  targetMinor: z.string(),
  startMonth: z.string(),
  endMonth: z.string(),
  status: z.enum(["ACTIVE", "ACHIEVED", "CANCELLED"]),
  currentMinor: z.string(),
  remainingMinor: z.string(),
  progressPercent: z.string().nullable(),
});

const reportExport = z.object({
  id: z.uuid(),
  report: z.string(),
  format: z.string(),
  locale: z.string(),
  digitStyle: z.string(),
  status: z.enum(["QUEUED", "RUNNING", "READY", "FAILED"]),
  fileName: z.string().nullable(),
  errorCode: z.string().nullable(),
});

const rate = z.object({ id: z.uuid(), fromCurrency: z.string(), toCurrency: z.string(), rateDate: z.string(), rate: z.string() });

const transfer = z.object({
  id: z.uuid(),
  fromBusinessId: z.uuid(),
  toBusinessId: z.uuid(),
  fromEntryId: z.uuid(),
  toEntryId: z.uuid(),
  amountMinor: z.string(),
  currency: z.string(),
  transferDate: z.string(),
  memo: z.string().nullable(),
});

const analytics = "/businesses/{businessId}/analytics";
const budgets = "/businesses/{businessId}/budgets";
const goals = "/businesses/{businessId}/goals";
const exportsPath = "/businesses/{businessId}/report-exports";

addPath("Analytics", { method: "get", path: `${analytics}/dashboard`, summary: "Revenue, expenses, profit, cash, trend and top expenses. Fiscal year to date by default. Needs finance.read", params: businessParams, query: analyticsValidation.dashboardQuery, response: dashboard });
addPath("Analytics", { method: "get", path: `${analytics}/compare`, summary: "Compare a metric between two month ranges. Needs finance.read", params: businessParams, query: analyticsValidation.compareQuery, response: z.object({ currency: z.string(), basis: z.literal("POSTED_ACTUALS"), metric: z.string(), current: comparePeriod, comparedTo: comparePeriod, changeMinor: z.string(), changePercent: z.string().nullable() }) });

addPath("Budgets", { method: "post", path: budgets, summary: "Create a budget. Needs finance.write", params: businessParams, body: budgetsValidation.create, response: budgetSummary, status: 201 });
addPath("Budgets", { method: "get", path: budgets, summary: "List budgets. Needs finance.read", params: businessParams, query: budgetsValidation.listQuery, response: z.array(budgetSummary) });
addPath("Budgets", { method: "get", path: `${budgets}/{budgetId}`, summary: "A budget against actuals from the ledger, with alerts. Needs finance.read", params: budgetParams, response: budgetSummary.extend({ currency: z.string(), basis: z.literal("POSTED_ACTUALS"), lines: z.array(budgetLine) }) });
addPath("Budgets", { method: "patch", path: `${budgets}/{budgetId}`, summary: "Rename or archive. Needs finance.write", params: budgetParams, body: budgetsValidation.update, response: budgetSummary });
addPath("Budgets", { method: "post", path: `${budgets}/{budgetId}/lines`, summary: "Add a line, or change a category's existing line. Needs finance.write", params: budgetParams, body: budgetsValidation.line });

addPath("Goals", { method: "post", path: goals, summary: "Create a goal. Needs finance.write", params: businessParams, body: goalsValidation.create, response: goal, status: 201 });
addPath("Goals", { method: "get", path: goals, summary: "List goals with progress. Needs finance.read", params: businessParams, query: goalsValidation.listQuery, response: z.array(goal) });
addPath("Goals", { method: "get", path: `${goals}/{goalId}`, summary: "One goal with progress. Needs finance.read", params: goalParams, response: goal });
addPath("Goals", { method: "patch", path: `${goals}/{goalId}`, summary: "Rename, change the target or cancel. Needs finance.write", params: goalParams, body: goalsValidation.update, response: goal });

addPath("Report exports", { method: "post", path: exportsPath, summary: "Queue a PDF, Excel or CSV export. The worker makes the file. Needs finance.read and recent MFA", params: businessParams, body: reportExportsValidation.create, response: reportExport, status: 202 });
addPath("Report exports", { method: "get", path: exportsPath, summary: "List exports. Needs finance.read", params: businessParams, query: reportExportsValidation.listQuery, response: z.array(reportExport) });
addPath("Report exports", { method: "get", path: `${exportsPath}/{exportId}`, summary: "Check an export's status. Needs finance.read", params: exportParams, response: reportExport });
addPath("Report exports", { method: "get", path: `${exportsPath}/{exportId}/download`, summary: "A 5-minute download link. Needs finance.read and recent MFA", params: exportParams, response: z.object({ url: z.string(), expiresIn: z.number() }) });

addPath("Exchange rates", { method: "post", path: "/exchange-rates", summary: "Save a rate in your workspace. Saving the same pair and date corrects it", body: exchangeRatesValidation.save, response: rate });
addPath("Exchange rates", { method: "get", path: "/exchange-rates", summary: "List your workspace's rates", query: exchangeRatesValidation.listQuery, response: z.array(rate) });

addPath("Consolidated", { method: "get", path: "/consolidated/dashboard", summary: "All businesses you may read, in one currency. The server works out which ones", query: consolidatedValidation.dashboardQuery, response: z.object({ reportingCurrency: z.string().nullable(), asOf: z.string(), fromMonth: z.string(), toMonth: z.string(), basis: z.literal("POSTED_ACTUALS"), totals: figures, eliminatedIntercompanyMinor: z.string(), fxRates: z.array(z.object({ fromCurrency: z.string(), toCurrency: z.string(), rate: z.string(), rateDate: z.string().nullable(), inverted: z.boolean() })), businesses: z.array(z.object({ businessId: z.uuid(), name: z.string(), status: z.string(), currency: z.string(), native: figures, converted: figures })) }) });
addPath("Consolidated", { method: "post", path: "/consolidated/intercompany-transfers", summary: "Move money between two of your businesses. Needs ledger.post in both", body: consolidatedValidation.createTransfer, response: transfer, status: 201 });
addPath("Consolidated", { method: "get", path: "/consolidated/intercompany-transfers", summary: "List transfers between your businesses", response: z.array(transfer) });
