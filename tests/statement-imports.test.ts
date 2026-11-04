import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { withRls } from "../src/lib/rls.js";
import { addMember, api, bearer, setupFinance, type FinanceSetup } from "./helpers/api.js";
import { notificationsFor } from "./helpers/delivery.js";
import { HEADER, importStatement, linesOf, MAPPING, uploadStatement } from "./helpers/statements.js";

vi.mock("../src/lib/mailer.js", () => ({ emailEnabled: () => true, sendEmail: vi.fn(async () => {}) }));

const STATEMENT = `${HEADER}
01/11/2026,Customer payment,R-1,,5000.00,15000.00
02/11/2026,Office rent,R-2,3000.00,,12000.00
`;

const preview = (f: FinanceSetup, body: object) => api().post(`${f.base}/statement-imports/preview`).set("Authorization", f.auth).send({ financialAccountId: f.bankId, ...body });

describe("uploading a statement", () => {
  it("accepts a CSV and an Excel file", async () => {
    const f = await setupFinance();
    expect((await uploadStatement(f, STATEMENT)).status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRow(["Date", "Debit"]);
    const excel = Buffer.from(await workbook.xlsx.writeBuffer());
    const res = await uploadStatement(f, excel, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "s.xlsx");
    expect(res.status).toBe(200);
  });

  it("refuses a binary file pretending to be CSV, and a PDF pretending to be Excel", async () => {
    const f = await setupFinance();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    expect((await uploadStatement(f, png)).status).toBe(422);
    expect((await uploadStatement(f, Buffer.from("%PDF-1.4\n"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "s.xlsx")).status).toBe(422);
  });

  it("only a statement may be a spreadsheet, and it must be one", async () => {
    const f = await setupFinance();
    const start = (body: object) => api().post(`${f.base}/documents/uploads`).set("Authorization", f.auth).send({ fileName: "x", sizeBytes: 10, ...body });
    expect((await start({ type: "RECEIPT", mime: "text/csv" })).status).toBe(422);
    expect((await start({ type: "STATEMENT", mime: "application/pdf" })).status).toBe(422);
    expect((await start({ type: "STATEMENT", mime: "text/csv", sizeBytes: 11 * 1024 * 1024 })).status).toBe(422);
  });
});

describe("previewing", () => {
  it("shows columns and a suggestion, changing nothing", async () => {
    const f = await setupFinance();
    const { body } = await uploadStatement(f, STATEMENT);
    const res = await preview(f, { documentId: body.data.id });
    expect(res.status).toBe(200);
    expect(res.body.data.headers).toEqual(["Date", "Details", "Ref", "Debit", "Credit", "Balance"]);
    expect(res.body.data.suggestion).toMatchObject({ dateColumn: "Date", debitColumn: "Debit", creditColumn: "Credit" });
    expect(res.body.data.dateFormats).toContain("DD/MM/YYYY");
    expect(await prisma.statementLine.count({ where: { businessId: f.businessId } })).toBe(0);
  });

  it("with a mapping, shows what would be imported", async () => {
    const f = await setupFinance();
    const { body } = await uploadStatement(f, STATEMENT);
    const res = await preview(f, { documentId: body.data.id, mapping: MAPPING });
    expect(res.body.data.result).toMatchObject({ totalRows: 2, readableRows: 2, failedRows: 0, balanceBreaks: 0 });
    expect(res.body.data.result.lines[0]).toMatchObject({ txnDate: "2026-11-01", direction: "IN", amountMinor: "500000" });
  });

  it("names a missing column, and refuses another kind of document", async () => {
    const f = await setupFinance();
    const { body } = await uploadStatement(f, STATEMENT);
    const res = await preview(f, { documentId: body.data.id, mapping: { ...MAPPING, creditColumn: "Deposit" } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "STATEMENT_COLUMN_MISSING", params: { column: "Deposit" } });

    const { uploadDocument } = await import("./helpers/api.js");
    const receipt = await uploadDocument(f.base, f.auth);
    expect((await preview(f, { documentId: receipt.id })).status).toBe(422);
  });
});

describe("importing", () => {
  it("adds the lines, unmatched, without touching the ledger", async () => {
    const f = await setupFinance();
    const before = await prisma.journalEntry.count({ where: { businessId: f.businessId } });
    const result = await importStatement(f, STATEMENT);
    expect(result).toMatchObject({ status: "COMPLETED", totalRows: 2, newLines: 2, duplicateRows: 0, failedRows: 0 });

    const lines = await linesOf(f);
    expect(lines.map((line) => line.status)).toEqual(["UNMATCHED", "UNMATCHED"]);
    expect(await prisma.journalEntry.count({ where: { businessId: f.businessId } })).toBe(before);
  });

  it("importing the same file twice adds nothing", async () => {
    const f = await setupFinance();
    await importStatement(f, STATEMENT);
    const second = await importStatement(f, STATEMENT);
    expect(second).toMatchObject({ status: "COMPLETED", newLines: 0, duplicateRows: 2 });
    expect(await linesOf(f)).toHaveLength(2);
  });

  it("two identical withdrawals in one file are both kept, and an overlapping month adds only what's new", async () => {
    const f = await setupFinance();
    const twice = `${HEADER}\n01/11/2026,ATM,,500.00,,\n01/11/2026,ATM,,500.00,,\n`;
    expect(await importStatement(f, twice)).toMatchObject({ newLines: 2 });
    const overlap = `${twice}05/11/2026,ATM,,500.00,,\n`;
    expect(await importStatement(f, overlap)).toMatchObject({ newLines: 1, duplicateRows: 2 });
  });

  it("the same file for another account is a different statement", async () => {
    const f = await setupFinance();
    await importStatement(f, STATEMENT);
    expect(await importStatement(f, STATEMENT, f.cashId)).toMatchObject({ newLines: 2 });
  });

  it("keeps good rows, reports bad rows, and warns about a broken balance", async () => {
    const f = await setupFinance();
    const result = await importStatement(f, `${HEADER}\n01/11/2026,A,,,1000.00,1000.00\n99/99/2026,B,,,1.00,\n02/11/2026,C,,300.00,,999.00\n`);
    expect(result).toMatchObject({ status: "COMPLETED", newLines: 2, failedRows: 1, balanceBreaks: 1 });
    expect(result.rowErrors).toEqual([{ row: 3, code: "INVALID_DATE" }]);
  });

  it("fails clearly when the mapping is wrong for the file", async () => {
    const f = await setupFinance();
    const allBad = await importStatement(f, `${HEADER}\nnot-a-date,A,,,1.00,\n`);
    expect(allBad).toMatchObject({ status: "FAILED", errorCode: "STATEMENT_FILE_UNREADABLE", newLines: 0 });

    const missing = await importStatement(f, STATEMENT, f.bankId, { ...MAPPING, debitColumn: "Withdrawal" });
    expect(missing).toMatchObject({ status: "FAILED", errorCode: "STATEMENT_COLUMN_MISSING" });
  });

  it("uses a saved template, keeping its own copy of the mapping", async () => {
    const f = await setupFinance();
    const template = await api().post(`${f.base}/statement-templates`).set("Authorization", f.auth).send({ name: "City Bank", mapping: MAPPING });
    expect(template.status).toBe(201);
    const { body } = await uploadStatement(f, STATEMENT);
    const requested = await api().post(`${f.base}/statement-imports`).set("Authorization", f.auth).send({ documentId: body.data.id, financialAccountId: f.bankId, templateId: template.body.data.id });
    expect(requested.status).toBe(202);
    expect(requested.body.data.mapping).toMatchObject({ dateColumn: "Date" });

    const removed = await api().delete(`${f.base}/statement-templates/${template.body.data.id}`).set("Authorization", f.auth);
    expect(removed.status).toBe(200);
    expect((await prisma.statementImport.findUniqueOrThrow({ where: { id: requested.body.data.id } })).mapping).toMatchObject({ dateColumn: "Date" });
  });

  it("template names are unique within a business", async () => {
    const f = await setupFinance();
    const save = () => api().post(`${f.base}/statement-templates`).set("Authorization", f.auth).send({ name: "City Bank", mapping: MAPPING });
    await save();
    expect((await save()).status).toBe(409);
  });

  it("tells the person who imported, in-app", async () => {
    const f = await setupFinance();
    await importStatement(f, STATEMENT);
    const [notification] = await notificationsFor(f.owner.userId, "statement_import.finished");
    expect(notification?.params).toMatchObject({ newLines: 2, needsReview: 2 });
  });

  it("checks permission again when the job runs", async () => {
    const f = await setupFinance();
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    const { body } = await uploadStatement(f, STATEMENT);
    const requested = await api().post(`${f.base}/statement-imports`).set("Authorization", bearer(accountant)).send({ documentId: body.data.id, financialAccountId: f.bankId, mapping: MAPPING });
    expect(requested.status).toBe(202);

    await prisma.businessMember.updateMany({ where: { businessId: f.businessId, userId: accountant.userId }, data: { status: "REMOVED" } });
    const { redis } = await import("../src/lib/redis.js");
    await redis.flushdb();
    const { runPendingEvents } = await import("./helpers/api.js");
    await runPendingEvents();

    const saved = await prisma.statementImport.findUniqueOrThrow({ where: { id: requested.body.data.id } });
    expect(saved).toMatchObject({ status: "FAILED", errorCode: "PERMISSION_DENIED" });
  });
});

describe("access", () => {
  it("a viewer can't import, and an outsider can't see", async () => {
    const f = await setupFinance();
    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    const other = await setupFinance();
    const { body } = await uploadStatement(f, STATEMENT);

    const attempt = await api().post(`${f.base}/statement-imports`).set("Authorization", bearer(viewer)).send({ documentId: body.data.id, financialAccountId: f.bankId, mapping: MAPPING });
    expect(attempt.status).toBe(403);
    expect((await api().get(`${f.base}/statement-lines`).set("Authorization", other.auth)).status).toBe(404);
  });

  it("a document or account from another business is refused", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    const { body } = await uploadStatement(other, STATEMENT);
    const foreignDocument = await api().post(`${f.base}/statement-imports`).set("Authorization", f.auth).send({ documentId: body.data.id, financialAccountId: f.bankId, mapping: MAPPING });
    expect(foreignDocument.status).toBe(422);

    const own = await uploadStatement(f, STATEMENT);
    const foreignAccount = await api().post(`${f.base}/statement-imports`).set("Authorization", f.auth).send({ documentId: own.body.data.id, financialAccountId: other.bankId, mapping: MAPPING });
    expect(foreignAccount.status).toBeGreaterThanOrEqual(400);
  });

  it("the database hides another business's lines, even with no filter", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    await importStatement(f, STATEMENT);
    const { workspaceId } = await prisma.business.findUniqueOrThrow({ where: { id: other.businessId } });
    const seen = await withRls({ userId: other.owner.userId, workspaceId, businessIds: [other.businessId] }, async (tx) => ({
      lines: await tx.statementLine.findMany(),
      imports: await tx.statementImport.findMany(),
    }));
    expect(seen).toEqual({ lines: [], imports: [] });
  });
});
