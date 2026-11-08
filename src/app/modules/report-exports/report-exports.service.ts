import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { createDownloadUrl, putObject } from "../../../lib/storage.js";
import { Permission } from "../../constants/permissions.js";
import { renderCsv } from "../../exports/renderCsv.js";
import { renderPdf } from "../../exports/renderPdf.js";
import { renderWorkbook, type Sheet } from "../../exports/renderWorkbook.js";
import { renderXlsx } from "../../exports/renderXlsx.js";
import {
  balanceSheetTable,
  cashFlowTable,
  profitAndLossTable,
  trialBalanceTable,
  type ExportOptions,
  type ReportTable,
} from "../../exports/reportTable.js";
import { fromDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import { NotificationType } from "../notifications/notifications.interface.js";
import { notificationsService } from "../notifications/notifications.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import { membersService } from "../members/members.service.js";
import { reportsService } from "../reports/reports.service.js";
import { usersService } from "../users/users.service.js";
import type { ExportParams, ICreateExportBody, IListExportsQuery } from "./report-exports.interface.js";

const FORMATS = {
  PDF: { extension: "pdf", mime: "application/pdf" },
  XLSX: { extension: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  CSV: { extension: "csv", mime: "text/csv; charset=utf-8" },
} as const;

// Never includes the internal storage key.
const publicFields = {
  id: true,
  report: true,
  format: true,
  params: true,
  locale: true,
  digitStyle: true,
  status: true,
  fileName: true,
  errorCode: true,
  requestedBy: true,
  finishedAt: true,
  createdAt: true,
} as const;

// Everything a business holds, in one workbook, so it can be taken elsewhere. Only owners and admins
// (business.manage) can ask for it or see it, since it covers more than the money reports do.
export const ALL_DATA = "ALL_DATA";
const canSeeAllData = (business: BusinessContext) => business.permissions.includes(Permission.BUSINESS_MANAGE);
const hiddenFrom = (business: BusinessContext) => (canSeeAllData(business) ? {} : { report: { not: ALL_DATA } });

// The request and its event commit together, so a saved request can't be left without a job.
const request = async (business: BusinessContext, body: ICreateExportBody, context: RequestContext) => {
  const user = await usersService.findById(business.userId);
  const params: ExportParams = body.asOf ? { asOf: body.asOf } : { from: body.from!, to: body.to! };

  return withBusinessScope(business, async (tx) => {
    const created = await tx.reportExport.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        report: body.report,
        format: body.format,
        params: { ...params },
        locale: body.locale ?? user?.locale ?? "en",
        digitStyle: body.digitStyle ?? user?.digitStyle ?? "latin",
        requestedBy: business.userId,
      },
      select: publicFields,
    });
    await publishEvent(tx, business, EventType.REPORT_EXPORT_REQUESTED, { exportId: created.id });
    await auditService.recordForBusiness(tx, business, {
      action: "report.export_requested",
      context,
      entityType: "report_export",
      entityId: created.id,
      after: { report: body.report, format: body.format, ...params },
    });
    return created;
  });
};

const requestData = async (business: BusinessContext, context: RequestContext) => {
  const user = await usersService.findById(business.userId);
  return withBusinessScope(business, async (tx) => {
    const created = await tx.reportExport.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        report: ALL_DATA,
        format: "XLSX",
        params: {},
        locale: user?.locale ?? "en",
        digitStyle: "latin",
        requestedBy: business.userId,
      },
      select: publicFields,
    });
    await publishEvent(tx, business, EventType.REPORT_EXPORT_REQUESTED, { exportId: created.id });
    await auditService.recordForBusiness(tx, business, {
      action: "business.data_export_requested",
      context,
      entityType: "report_export",
      entityId: created.id,
    });
    return created;
  });
};

const list = (business: BusinessContext, query: IListExportsQuery) =>
  withBusinessScope(business, (tx) =>
    tx.reportExport.findMany({
      where: { businessId: business.businessId, ...hiddenFrom(business) },
      orderBy: { id: "desc" },
      take: query.limit,
      select: publicFields,
    }),
  );

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, exportId: string) => {
  const row = await tx.reportExport.findFirst({ where: { id: exportId, businessId } });
  if (!row) throw new AppError(404, ErrorCode.NOT_FOUND);
  return row;
};

const day = (value: Date | null) => (value ? fromDbDate(value) : null);
const moment = (value: Date | null) => (value ? value.toISOString() : null);
const percent = (bp: number) => bp / 100;

// One sheet per kind of record. Names stand in for ids so the file reads on its own.
const dataSheets = (business: BusinessContext, about: { name: string; legalName: string | null; currency: string }) =>
  withBusinessScope(business, async (tx): Promise<Sheet[]> => {
    const where = { businessId: business.businessId };
    const [accounts, categories, contacts, items, transactions, invoices, payments, ledger, entries, budgets, goals, tasks] = await Promise.all([
      tx.financialAccount.findMany({ where, orderBy: { name: "asc" } }),
      tx.category.findMany({ where, orderBy: [{ type: "asc" }, { name: "asc" }] }),
      tx.contact.findMany({ where, orderBy: { name: "asc" } }),
      tx.item.findMany({ where, orderBy: { name: "asc" } }),
      tx.transaction.findMany({ where, orderBy: [{ txnDate: "asc" }, { number: "asc" }] }),
      tx.invoice.findMany({ where, orderBy: [{ issueDate: "asc" }, { id: "asc" }], include: { lines: { orderBy: { lineNo: "asc" } } } }),
      tx.invoicePayment.findMany({ where, orderBy: [{ paidOn: "asc" }, { id: "asc" }] }),
      tx.ledgerAccount.findMany({ where, orderBy: { code: "asc" } }),
      tx.journalEntry.findMany({ where, orderBy: [{ entryDate: "asc" }, { entryNo: "asc" }], include: { lines: { orderBy: { lineNo: "asc" } } } }),
      tx.budget.findMany({ where, orderBy: { startMonth: "asc" }, include: { lines: true } }),
      tx.goal.findMany({ where, orderBy: { startMonth: "asc" } }),
      tx.task.findMany({ where, orderBy: { createdAt: "asc" } }),
    ]);
    const names = <T extends { id: string }>(rows: T[], label: (row: T) => string) => new Map(rows.map((row) => [row.id, label(row)]));
    const accountName = names(accounts, (row) => row.name);
    const categoryName = names(categories, (row) => row.name);
    const contactName = names(contacts, (row) => row.name);
    const itemName = names(items, (row) => row.name);
    const ledgerById = new Map(ledger.map((row) => [row.id, row]));
    // A draft has no number yet, so it is named by the end of its id.
    const invoiceLabel = names(invoices, (row) => row.number ?? `DRAFT-${row.id.slice(-8)}`);
    const of = (map: Map<string, string>, id: string | null) => (id ? (map.get(id) ?? null) : null);
    const money = true;

    return [
      {
        name: "About",
        columns: [{ label: "Field", width: 24 }, { label: "Value", width: 60 }],
        rows: [
          ["Business", about.name],
          ["Legal name", about.legalName],
          ["Currency", about.currency],
          ["Exported at", new Date().toISOString()],
          ["Amounts", `In ${about.currency}, with two decimals. Invoice and item prices are before VAT.`],
          ["Dates", "YYYY-MM-DD. Times are UTC."],
          ["Not included", "Uploaded files (download them from Documents), the activity history, and team members' details."],
        ],
      },
      {
        name: "Accounts",
        columns: [{ label: "Name" }, { label: "Type" }, { label: "Currency" }, { label: "Opening balance", money }, { label: "Opening date" }, { label: "Current balance", money }, { label: "Number" }, { label: "Active" }],
        rows: accounts.map((row) => [row.name, row.type, row.currency, row.openingBalanceMinor, day(row.openingDate), row.currentBalanceMinor, row.maskedNumber, row.isActive]),
      },
      {
        name: "Categories",
        columns: [{ label: "Type" }, { label: "Name" }, { label: "Name (Bangla)" }, { label: "Active" }],
        rows: categories.map((row) => [row.type, row.name, row.nameBn, row.isActive]),
      },
      {
        name: "Customers and suppliers",
        columns: [{ label: "Kind" }, { label: "Name" }, { label: "Company" }, { label: "Phone" }, { label: "Email" }, { label: "Address", width: 40 }, { label: "BIN/TIN" }, { label: "Notes", width: 40 }, { label: "Active" }],
        rows: contacts.map((row) => [row.kind, row.name, row.company, row.phone, row.email, row.address, row.taxId, row.notes, row.isActive]),
      },
      {
        name: "Items",
        columns: [{ label: "Name" }, { label: "Code" }, { label: "Unit" }, { label: "Selling price", money }, { label: "Buying price", money }, { label: "VAT %" }, { label: "Income category" }, { label: "Expense category" }, { label: "Note", width: 40 }, { label: "Active" }],
        rows: items.map((row) => [row.name, row.code, row.unit, row.salePriceMinor, row.purchasePriceMinor, percent(row.vatRateBp), of(categoryName, row.incomeCategoryId), of(categoryName, row.expenseCategoryId), row.description, row.isActive]),
      },
      {
        name: "Transactions",
        columns: [{ label: "Number" }, { label: "Date" }, { label: "Type" }, { label: "Status" }, { label: "Account" }, { label: "To account" }, { label: "Category" }, { label: "Customer or supplier" }, { label: "Amount", money }, { label: "Fee", money }, { label: "Currency" }, { label: "Method" }, { label: "Reference" }, { label: "Description", width: 40 }, { label: "Source" }],
        rows: transactions.map((row) => [row.number, day(row.txnDate), row.type, row.status, of(accountName, row.accountId), of(accountName, row.toAccountId), of(categoryName, row.categoryId), of(contactName, row.contactId), row.amountMinor, row.feeMinor, row.currency, row.paymentMethod, row.referenceNo, row.description, row.source]),
      },
      {
        name: "Invoices and bills",
        columns: [{ label: "Kind" }, { label: "Number" }, { label: "Status" }, { label: "Customer or supplier" }, { label: "Date" }, { label: "Due date" }, { label: "Subtotal", money }, { label: "VAT", money }, { label: "Total", money }, { label: "Paid", money }, { label: "Reference" }, { label: "Notes", width: 40 }, { label: "Void reason" }],
        rows: invoices.map((row) => [row.kind, invoiceLabel.get(row.id)!, row.status, of(contactName, row.contactId), day(row.issueDate), day(row.dueDate), row.subtotalMinor, row.vatMinor, row.totalMinor, row.paidMinor, row.referenceNo, row.notes, row.voidReason]),
      },
      {
        name: "Invoice lines",
        columns: [{ label: "Invoice or bill" }, { label: "Line" }, { label: "Item" }, { label: "Description", width: 40 }, { label: "Quantity" }, { label: "Unit" }, { label: "Unit price", money }, { label: "Amount", money }, { label: "VAT %" }, { label: "VAT", money }, { label: "Category" }],
        rows: invoices.flatMap((invoice) =>
          invoice.lines.map((row) => [invoiceLabel.get(invoice.id)!, row.lineNo, of(itemName, row.itemId), row.description, Number(row.quantity), row.unit, row.unitPriceMinor, row.amountMinor, percent(row.vatRateBp), row.vatMinor, of(categoryName, row.categoryId)]),
        ),
      },
      {
        name: "Invoice payments",
        columns: [{ label: "Invoice or bill" }, { label: "Date" }, { label: "Account" }, { label: "Amount", money }, { label: "Note", width: 40 }, { label: "Undone" }],
        rows: payments.map((row) => [of(invoiceLabel, row.invoiceId), day(row.paidOn), of(accountName, row.accountId), row.amountMinor, row.note, row.voidedAt !== null]),
      },
      {
        name: "Chart of accounts",
        columns: [{ label: "Code" }, { label: "Name", width: 32 }, { label: "Name (Bangla)", width: 32 }, { label: "Type" }, { label: "Normal balance" }, { label: "Active" }],
        rows: ledger.map((row) => [row.code, row.name, row.nameBn, row.type, row.normalBalance, row.isActive]),
      },
      {
        name: "Journal",
        columns: [{ label: "Entry" }, { label: "Date" }, { label: "Kind" }, { label: "Memo", width: 40 }, { label: "Line" }, { label: "Account code" }, { label: "Account", width: 32 }, { label: "Debit", money }, { label: "Credit", money }, { label: "Currency" }, { label: "Line memo", width: 32 }],
        rows: entries.flatMap((entry) =>
          entry.lines.map((row) => {
            const account = ledgerById.get(row.ledgerAccountId);
            return [entry.entryNo, day(entry.entryDate), entry.kind, entry.memo, row.lineNo, account?.code ?? null, account?.name ?? null, row.debitMinor, row.creditMinor, row.currency, row.memo];
          }),
        ),
      },
      {
        name: "Budgets",
        columns: [{ label: "Budget" }, { label: "From month" }, { label: "To month" }, { label: "Status" }, { label: "Category" }, { label: "Amount a month", money }, { label: "Alert at %" }],
        rows: budgets.flatMap((budget) =>
          budget.lines.map((row) => [budget.name, day(budget.startMonth), day(budget.endMonth), budget.status, of(categoryName, row.categoryId), row.amountMinor, row.alertPercent]),
        ),
      },
      {
        name: "Goals",
        columns: [{ label: "Name" }, { label: "Measure" }, { label: "Target", money }, { label: "From month" }, { label: "To month" }, { label: "Status" }, { label: "Reached at" }],
        rows: goals.map((row) => [row.name, row.metric, row.targetMinor, day(row.startMonth), day(row.endMonth), row.status, moment(row.achievedAt)]),
      },
      {
        name: "Tasks",
        columns: [{ label: "Title", width: 40 }, { label: "Description", width: 40 }, { label: "Priority" }, { label: "Status" }, { label: "Due" }, { label: "Done at" }, { label: "Created at" }],
        rows: tasks.map((row) => [row.title, row.description, row.priority, row.status, moment(row.dueAt), moment(row.completedAt), moment(row.createdAt)]),
      },
    ];
  });

const getOne = (business: BusinessContext, exportId: string) =>
  withBusinessScope(business, (tx) =>
    tx.reportExport.findFirst({ where: { id: exportId, businessId: business.businessId, ...hiddenFrom(business) }, select: publicFields }),
  ).then((row) => {
    if (!row) throw new AppError(404, ErrorCode.NOT_FOUND);
    return row;
  });

const getDownloadUrl = async (business: BusinessContext, exportId: string) => {
  const row = await withBusinessScope(business, (tx) => findOrThrow(tx, business.businessId, exportId));
  if (row.report === ALL_DATA && !canSeeAllData(business)) throw new AppError(404, ErrorCode.NOT_FOUND);
  if (row.status !== "READY" || !row.storageKey || !row.fileName) {
    throw new AppError(409, ErrorCode.EXPORT_NOT_READY, { status: row.status });
  }
  return createDownloadUrl(row.storageKey, row.fileName);
};

const buildTable = async (
  report: string,
  params: ExportParams,
  business: BusinessContext,
  options: ExportOptions,
): Promise<ReportTable> => {
  switch (report) {
    case "TRIAL_BALANCE":
      return trialBalanceTable(await reportsService.trialBalance(business, params.asOf!), options);
    case "PROFIT_AND_LOSS":
      return profitAndLossTable(await reportsService.profitAndLoss(business, params.from!, params.to!), options);
    case "BALANCE_SHEET":
      return balanceSheetTable(await reportsService.balanceSheet(business, params.asOf!), options);
    case "CASH_FLOW":
      return cashFlowTable(await reportsService.cashFlow(business, params.from!, params.to!), options);
    default:
      throw new Error(`unknown report ${report}`);
  }
};

const render = (format: string, table: ReportTable, options: ExportOptions) => {
  if (format === "PDF") return renderPdf(table, options);
  if (format === "XLSX") return renderXlsx(table);
  return Promise.resolve(renderCsv(table));
};

const updateStatus = (id: string, data: Prisma.ReportExportUpdateManyMutationInput) =>
  prisma.reportExport.updateMany({ where: { id, status: { in: ["QUEUED", "RUNNING"] } }, data });

// Runs in the worker. A repeat run of a finished export does nothing.
const tellRequester = async (exportId: string, type: NotificationType) => {
  const row = await prisma.reportExport.findUniqueOrThrow({ where: { id: exportId } });
  await notificationsService.notifySafely([
    {
      type,
      userId: row.requestedBy,
      workspaceId: row.workspaceId,
      businessId: row.businessId,
      params: { report: row.report, format: row.format },
      entityType: "report_export",
      entityId: row.id,
      dedupeKey: `${type}:${row.id}`,
    },
  ]);
};

const run = async (exportId: string) => {
  const row = await prisma.reportExport.findUnique({ where: { id: exportId } });
  if (!row || row.status === "READY" || row.status === "FAILED") return;

  // Access may have changed since the request, so it is checked again as the person who asked.
  const business = await membersService.resolveContext(row.requestedBy, row.businessId);
  const needed = row.report === ALL_DATA ? Permission.BUSINESS_MANAGE : Permission.FINANCE_READ;
  if (!business?.permissions.includes(needed)) {
    await updateStatus(exportId, { status: "FAILED", errorCode: ErrorCode.PERMISSION_DENIED, finishedAt: new Date() });
    return;
  }

  await updateStatus(exportId, { status: "RUNNING" });

  const details = await prisma.business.findUniqueOrThrow({
    where: { id: row.businessId },
    select: { name: true, legalName: true, baseCurrency: true, settings: true },
  });

  if (row.report === ALL_DATA) {
    const sheets = await dataSheets(business, { name: details.name, legalName: details.legalName, currency: details.baseCurrency });
    const bytes = await renderWorkbook(sheets, details.baseCurrency);
    const storageKey = `workspaces/${row.workspaceId}/businesses/${row.businessId}/exports/${row.id}.xlsx`;
    await putObject(storageKey, bytes, FORMATS.XLSX.mime);
    const slug = details.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "business";
    await updateStatus(exportId, { status: "READY", storageKey, fileName: `${slug}-data-${fromDbDate(new Date())}.xlsx`, finishedAt: new Date() });
    await tellRequester(exportId, NotificationType.EXPORT_READY);
    return;
  }
  const settings = details.settings as { numberGrouping?: "lakh" | "western" };
  const options: ExportOptions = {
    businessName: details.name,
    locale: row.locale as ExportOptions["locale"],
    digitStyle: row.digitStyle as ExportOptions["digitStyle"],
    grouping: settings.numberGrouping ?? "lakh",
  };

  const params = row.params as ExportParams;
  const table = await buildTable(row.report, params, business, options);
  const bytes = await render(row.format, table, options);

  const format = FORMATS[row.format as keyof typeof FORMATS];
  const storageKey = `workspaces/${row.workspaceId}/businesses/${row.businessId}/exports/${row.id}.${format.extension}`;
  await putObject(storageKey, bytes, format.mime);

  const dates = params.asOf ?? `${params.from}_${params.to}`;
  await updateStatus(exportId, {
    status: "READY",
    storageKey,
    fileName: `${row.report.toLowerCase().replaceAll("_", "-")}-${dates}.${format.extension}`,
    finishedAt: new Date(),
  });
  await tellRequester(exportId, NotificationType.EXPORT_READY);
};

// When retries run out.
const markFailed = async (exportId: string) => {
  await updateStatus(exportId, { status: "FAILED", errorCode: ErrorCode.INTERNAL_ERROR, finishedAt: new Date() });
  await tellRequester(exportId, NotificationType.EXPORT_FAILED);
};

export const reportExportsService = { request, requestData, list, getOne, getDownloadUrl, run, markFailed };
