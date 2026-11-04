import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { createDownloadUrl, putObject } from "../../../lib/storage.js";
import { Permission } from "../../constants/permissions.js";
import { renderCsv } from "../../exports/renderCsv.js";
import { renderPdf } from "../../exports/renderPdf.js";
import { renderXlsx } from "../../exports/renderXlsx.js";
import {
  balanceSheetTable,
  cashFlowTable,
  profitAndLossTable,
  trialBalanceTable,
  type ExportOptions,
  type ReportTable,
} from "../../exports/reportTable.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
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

const list = (business: BusinessContext, query: IListExportsQuery) =>
  withBusinessScope(business, (tx) =>
    tx.reportExport.findMany({
      where: { businessId: business.businessId },
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

const getOne = (business: BusinessContext, exportId: string) =>
  withBusinessScope(business, (tx) =>
    tx.reportExport.findFirst({ where: { id: exportId, businessId: business.businessId }, select: publicFields }),
  ).then((row) => {
    if (!row) throw new AppError(404, ErrorCode.NOT_FOUND);
    return row;
  });

const getDownloadUrl = async (business: BusinessContext, exportId: string) => {
  const row = await withBusinessScope(business, (tx) => findOrThrow(tx, business.businessId, exportId));
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
const run = async (exportId: string) => {
  const row = await prisma.reportExport.findUnique({ where: { id: exportId } });
  if (!row || row.status === "READY" || row.status === "FAILED") return;

  // Access may have changed since the request, so it is checked again as the person who asked.
  const business = await membersService.resolveContext(row.requestedBy, row.businessId);
  if (!business?.permissions.includes(Permission.FINANCE_READ)) {
    await updateStatus(exportId, { status: "FAILED", errorCode: ErrorCode.PERMISSION_DENIED, finishedAt: new Date() });
    return;
  }

  await updateStatus(exportId, { status: "RUNNING" });

  const details = await prisma.business.findUniqueOrThrow({
    where: { id: row.businessId },
    select: { name: true, settings: true },
  });
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
};

// When retries run out.
const markFailed = (exportId: string) =>
  updateStatus(exportId, { status: "FAILED", errorCode: ErrorCode.INTERNAL_ERROR, finishedAt: new Date() });

export const reportExportsService = { request, list, getOne, getDownloadUrl, run, markFailed };
