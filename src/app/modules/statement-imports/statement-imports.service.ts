import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { readObjectBytes } from "../../../lib/storage.js";
import { Permission } from "../../constants/permissions.js";
import {
  fileDedupeHashes,
  parseStatement,
  readStatementRows,
  StatementFileError,
  statementMapping,
  suggestMapping,
  type StatementMapping,
} from "../../integrations/statementFile.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { accountsService } from "../accounts/accounts.service.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import { membersService } from "../members/members.service.js";
import { NotificationType } from "../notifications/notifications.interface.js";
import { notificationsService } from "../notifications/notifications.service.js";
import { MAX_STATEMENT_BYTES } from "../documents/documents.validation.js";
import { statementLinesService } from "../statement-lines/statement-lines.service.js";
import { statementTemplatesService } from "../statement-templates/statement-templates.service.js";
import type { ICreateImportBody, IListImportsQuery, IPreviewBody } from "./statement-imports.interface.js";

const PREVIEW_ROWS = 20;
const SAVE_BATCH = 1000;

const FILE_ERRORS = {
  UNREADABLE: { status: 422, code: ErrorCode.STATEMENT_FILE_UNREADABLE },
  TOO_MANY_ROWS: { status: 422, code: ErrorCode.STATEMENT_FILE_TOO_LARGE },
  COLUMN_MISSING: { status: 422, code: ErrorCode.STATEMENT_COLUMN_MISSING },
} as const;

const toAppError = (error: unknown) => {
  if (!(error instanceof StatementFileError)) return error;
  const { status, code } = FILE_ERRORS[error.code];
  return new AppError(status, code, error.detail ? { column: error.detail } : undefined);
};

// The file must be a finished statement upload in this business.
const findStatementDocument = async (tx: Prisma.TransactionClient, businessId: string, documentId: string) => {
  const document = await tx.document.findFirst({
    where: { id: documentId, businessId, deletedAt: null, status: "READY", type: "STATEMENT" },
    select: { id: true, storageKey: true, mime: true, sizeBytes: true, fileName: true },
  });
  if (!document) throw new AppError(422, ErrorCode.DOCUMENT_NOT_READY, { documentId });
  return document;
};

const readRows = async (document: { storageKey: string; mime: string; sizeBytes: bigint }) => {
  if (document.sizeBytes > BigInt(MAX_STATEMENT_BYTES)) throw new AppError(422, ErrorCode.STATEMENT_FILE_TOO_LARGE);
  const bytes = await readObjectBytes(document.storageKey);
  if (!bytes) throw new AppError(409, ErrorCode.DOCUMENT_NOT_UPLOADED);
  return readStatementRows(bytes, document.mime);
};

// Changes nothing. Shows the columns and a suggested mapping, and with a mapping, what would be imported.
const preview = async (business: BusinessContext, body: IPreviewBody) => {
  const { document, account, mapping } = await withBusinessScope(business, async (tx) => ({
    document: await findStatementDocument(tx, business.businessId, body.documentId),
    account: await accountsService.getUsable(tx, business.businessId, body.financialAccountId),
    mapping: body.templateId ? await statementTemplatesService.getMapping(tx, business.businessId, body.templateId) : body.mapping,
  }));

  try {
    const rows = await readRows(document);
    const detected = suggestMapping(rows);
    const parsed = mapping ? parseStatement(rows, mapping as StatementMapping, account.currency) : null;
    return {
      ...detected,
      fileName: document.fileName,
      currency: account.currency,
      rawRows: rows.slice(0, PREVIEW_ROWS),
      ...(parsed
        ? {
            result: {
              totalRows: parsed.totalRows,
              readableRows: parsed.lines.length,
              failedRows: parsed.failedRows,
              balanceBreaks: parsed.balanceBreaks,
              errors: parsed.errors,
              lines: parsed.lines.slice(0, PREVIEW_ROWS),
            },
          }
        : {}),
    };
  } catch (error) {
    throw toAppError(error);
  }
};

const publicFields = {
  id: true,
  financialAccountId: true,
  documentId: true,
  mapping: true,
  status: true,
  totalRows: true,
  newLines: true,
  duplicateRows: true,
  failedRows: true,
  balanceBreaks: true,
  rowErrors: true,
  errorCode: true,
  requestedBy: true,
  finishedAt: true,
  createdAt: true,
} as const;

const request = (business: BusinessContext, body: ICreateImportBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const document = await findStatementDocument(tx, business.businessId, body.documentId);
    await accountsService.getUsable(tx, business.businessId, body.financialAccountId);
    // A copy, so changing the template later doesn't change what this import did.
    const mapping = body.templateId ? await statementTemplatesService.getMapping(tx, business.businessId, body.templateId) : body.mapping!;

    const row = await tx.statementImport.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        financialAccountId: body.financialAccountId,
        documentId: document.id,
        mapping: mapping as Prisma.InputJsonValue,
        requestedBy: business.userId,
      },
      select: publicFields,
    });
    await auditService.recordForBusiness(tx, business, {
      action: "statement_import.requested",
      context,
      entityType: "statement_import",
      entityId: row.id,
      after: { fileName: document.fileName, financialAccountId: body.financialAccountId },
    });
    await publishEvent(tx, business, EventType.STATEMENT_IMPORT_REQUESTED, { importId: row.id });
    return row;
  });

const list = async (business: BusinessContext, query: IListImportsQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.statementImport.findMany({
      where: { businessId: business.businessId, ...(query.financialAccountId ? { financialAccountId: query.financialAccountId } : {}) },
      orderBy: { id: "desc" },
      select: publicFields,
      ...pageArgs(query),
    }),
  );
  return toPage(rows, query.limit);
};

const getOne = async (business: BusinessContext, importId: string) => {
  const row = await withBusinessScope(business, (tx) =>
    tx.statementImport.findFirst({ where: { id: importId, businessId: business.businessId }, select: publicFields }),
  );
  if (!row) throw new AppError(404, ErrorCode.NOT_FOUND);
  return row;
};

const tellRequester = (row: { id: string; workspaceId: string; businessId: string; requestedBy: string }, newLines: number, needsReview: number) =>
  notificationsService.notifySafely([
    {
      type: NotificationType.STATEMENT_IMPORT_FINISHED,
      userId: row.requestedBy,
      workspaceId: row.workspaceId,
      businessId: row.businessId,
      params: { importId: row.id, newLines, needsReview },
      entityType: "statement_import",
      entityId: row.id,
      dedupeKey: `${NotificationType.STATEMENT_IMPORT_FINISHED}:${row.id}`,
    },
  ]);

const fail = async (importId: string, errorCode: string) => {
  await prisma.statementImport.update({ where: { id: importId }, data: { status: "FAILED", errorCode, finishedAt: new Date() } });
};

// Runs in the worker. A repeat after a crash finds its rows already there, so nothing is added twice.
const run = async (importId: string) => {
  const row = await prisma.statementImport.findUnique({ where: { id: importId } });
  if (!row || row.status === "COMPLETED" || row.status === "FAILED") return;

  // Access may have changed since the request, so it is checked again as the person who asked.
  const business = await membersService.resolveContext(row.requestedBy, row.businessId);
  if (!business?.permissions.includes(Permission.FINANCE_WRITE)) return fail(importId, ErrorCode.PERMISSION_DENIED);

  await prisma.statementImport.update({ where: { id: importId }, data: { status: "RUNNING" } });

  const context: RequestContext = { ip: null, userAgent: "worker", requestId: `statement-import-${importId}` };

  try {
    const { document, account } = await withBusinessScope(business, async (tx) => ({
      document: await findStatementDocument(tx, row.businessId, row.documentId),
      account: await accountsService.getUsable(tx, row.businessId, row.financialAccountId),
    }));
    const rows = await readRows(document);
    const parsed = parseStatement(rows, statementMapping.parse(row.mapping), account.currency);
    if (parsed.totalRows > 0 && parsed.lines.length === 0) {
      // Every row failing means the mapping is wrong for this file, not that the rows are bad.
      await prisma.statementImport.update({ where: { id: importId }, data: { totalRows: parsed.totalRows, failedRows: parsed.failedRows, rowErrors: parsed.errors as unknown as Prisma.InputJsonValue } });
      return fail(importId, ErrorCode.STATEMENT_FILE_UNREADABLE);
    }

    const hashes = fileDedupeHashes(parsed.lines);
    const hashed = parsed.lines.map((line, index) => ({ line, dedupeHash: hashes[index]! }));
    let newLines = 0;
    // Small transactions, so a long statement can't hit the time limit. A crash resumes safely.
    for (let start = 0; start < hashed.length; start += SAVE_BATCH) {
      const { created } = await withBusinessScope(business, (tx) =>
        statementLinesService.ingest(
          tx,
          { workspaceId: row.workspaceId, businessId: row.businessId, financialAccountId: row.financialAccountId, importId },
          hashed.slice(start, start + SAVE_BATCH),
        ),
      );
      newLines += created.length;
    }

    // Everything from this file still open, which includes any lines left by a crashed attempt.
    const open = await prisma.statementLine.findMany({ where: { importId, status: "UNMATCHED" }, select: { id: true }, orderBy: { id: "asc" } });
    const outcome = await statementLinesService.matchLines(business, open.map((line) => line.id), context);

    await prisma.statementImport.update({
      where: { id: importId },
      data: {
        status: "COMPLETED",
        totalRows: parsed.totalRows,
        newLines,
        duplicateRows: hashed.length - newLines,
        failedRows: parsed.failedRows,
        balanceBreaks: parsed.balanceBreaks,
        rowErrors: parsed.errors as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
    await tellRequester(row, newLines, outcome.needsReview);
  } catch (error) {
    const appError = toAppError(error);
    if (appError instanceof AppError) return fail(importId, appError.code);
    throw error;
  }
};

// When retries run out.
const markFailed = (importId: string) => fail(importId, ErrorCode.INTERNAL_ERROR);

export const statementImportsService = { preview, request, list, getOne, run, markFailed };
