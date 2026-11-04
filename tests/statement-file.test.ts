import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { fileDedupeHashes, parseStatement, parseStatementAmount, parseStatementDate, readStatementRows, statementMapping, StatementFileError, suggestMapping } from "../src/app/integrations/statementFile.js";

const csv = (text: string) => Buffer.from(text, "utf8");
const rowsOf = (text: string) => readStatementRows(csv(text), "text/csv");
const map = (extra: object) => statementMapping.parse({ dateColumn: "Date", dateFormat: "DD/MM/YYYY", debitColumn: "Debit", creditColumn: "Credit", ...extra });

describe("amounts", () => {
  const cases: [string, bigint | null][] = [
    ["1,25,000.50", 12500050n],
    ["৳1,000", 100000n],
    ["BDT 500.5", 50050n],
    ["১২,৫০০.০০", 1250000n],
    ["-300", -30000n],
    ["(300.00)", -30000n],
    ["300.00-", -30000n],
    ["500 Dr", -50000n],
    ["500 Cr", 50000n],
    ["0.10", 10n],
    [".5", 50n],
    ["12.3400", 1234n],
    ["", null],
    ["-", null],
    ["abc", null],
    ["1e5", null],
    ["1.2.3", null],
    ["10.555", null],
  ];
  for (const [text, expected] of cases) {
    it(`reads "${text}"`, () => expect(parseStatementAmount(text, "BDT")).toBe(expected));
  }

  it("never loses precision on a huge amount", () => {
    expect(parseStatementAmount("90,07,19,92,54,74,09,93.17", "BDT")).toBe(900719925474099317n);
  });

  it("knows a currency with no paisa", () => {
    expect(parseStatementAmount("1000", "JPY")).toBe(1000n);
    expect(parseStatementAmount("1000.50", "JPY")).toBeNull();
  });
});

describe("dates", () => {
  const cases: [string, Parameters<typeof parseStatementDate>[1], string | null][] = [
    ["05/11/2026", "DD/MM/YYYY", "2026-11-05"],
    ["05/11/2026", "MM/DD/YYYY", "2026-05-11"],
    ["2026-11-05", "YYYY-MM-DD", "2026-11-05"],
    ["05-Nov-2026", "DD-MMM-YYYY", "2026-11-05"],
    ["5 November 2026", "DD MMM YYYY", "2026-11-05"],
    ["05.11.2026", "DD.MM.YYYY", "2026-11-05"],
    ["০৫/১১/২০২৬", "DD/MM/YYYY", "2026-11-05"],
    ["05/11/2026 14:30:00", "DD/MM/YYYY", "2026-11-05"],
    ["31/02/2026", "DD/MM/YYYY", null],
    ["13/13/2026", "DD/MM/YYYY", null],
    ["Closing balance", "DD/MM/YYYY", null],
  ];
  for (const [text, format, expected] of cases) {
    it(`reads "${text}" as ${format}`, () => expect(parseStatementDate(text, format)).toBe(expected));
  }
});

describe("reading files", () => {
  it("handles a byte order mark, quotes and commas in text", async () => {
    const rows = await rowsOf('﻿Date,Details,Debit\n05/11/2026,"Rent, November",100\n');
    expect(rows[0]![0]).toBe("Date");
    expect(rows[1]![1]).toBe("Rent, November");
  });

  it("handles semicolons and tabs, which Excel uses in some regions", async () => {
    expect((await rowsOf("Date;Debit\n05/11/2026;100\n"))[1]).toEqual(["05/11/2026", "100"]);
    expect((await rowsOf("Date\tDebit\n05/11/2026\t100\n"))[1]).toEqual(["05/11/2026", "100"]);
  });

  it("handles a UTF-16 file saved by Excel", async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Date,Debit\n05/11/2026,100\n", "utf16le")]);
    expect((await readStatementRows(bytes, "text/csv"))[1]).toEqual(["05/11/2026", "100"]);
  });

  it("reads Bangla text intact", async () => {
    const rows = await rowsOf("Date,Details\n05/11/2026,বাড়ি ভাড়া\n");
    expect(rows[1]![1]).toBe("বাড়ি ভাড়া");
  });

  it("reads an Excel file, including real dates, formulas and empty cells", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Statement");
    sheet.addRow(["Date", "Details", "Debit", "Credit", "Balance"]);
    sheet.addRow([new Date("2026-11-05T00:00:00.000Z"), "Rent", 1500.5, null, { formula: "1000-1", result: 999 }]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const rows = await readStatementRows(bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const parsed = parseStatement(rows, map({ descriptionColumn: "Details", balanceColumn: "Balance" }), "BDT");
    expect(parsed.lines[0]).toMatchObject({ txnDate: "2026-11-05", direction: "OUT", amountMinor: 150050n, balanceAfterMinor: 99900n, description: "Rent" });
  });

  it("refuses a file that isn't really a spreadsheet", async () => {
    await expect(readStatementRows(Buffer.from("not a zip"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).rejects.toBeInstanceOf(StatementFileError);
  });
});

describe("applying a mapping", () => {
  it("reads debit and credit columns", async () => {
    const rows = await rowsOf("Date,Details,Debit,Credit,Balance\n01/11/2026,Sale,,5000.00,15000.00\n02/11/2026,Rent,3000.00,,12000.00\n");
    const parsed = parseStatement(rows, map({ descriptionColumn: "Details", balanceColumn: "Balance" }), "BDT");
    expect(parsed.lines.map((line) => [line.direction, line.amountMinor])).toEqual([["IN", 500000n], ["OUT", 300000n]]);
    expect(parsed.failedRows).toBe(0);
    expect(parsed.balanceBreaks).toBe(0);
  });

  it("reads one signed amount column", async () => {
    const rows = await rowsOf("Date,Amount\n01/11/2026,5000\n02/11/2026,-3000\n");
    const parsed = parseStatement(rows, statementMapping.parse({ dateColumn: "Date", dateFormat: "DD/MM/YYYY", amountColumn: "Amount" }), "BDT");
    expect(parsed.lines.map((line) => line.direction)).toEqual(["IN", "OUT"]);
  });

  it("reads an amount with a Dr/Cr column", async () => {
    const rows = await rowsOf("Date,Amount,Type\n01/11/2026,5000,CR\n02/11/2026,3000,DR\n");
    const parsed = parseStatement(rows, statementMapping.parse({ dateColumn: "Date", dateFormat: "DD/MM/YYYY", amountColumn: "Amount", directionColumn: "Type" }), "BDT");
    expect(parsed.lines.map((line) => line.direction)).toEqual(["IN", "OUT"]);
  });

  it("skips the bank's heading rows and its footer", async () => {
    const rows = await rowsOf("City Bank Statement,,\nAccount: 1234,,\nDate,Debit,Credit\n01/11/2026,100,\n,,\nClosing balance,,\n");
    const parsed = parseStatement(rows, map({ headerRow: 3 }), "BDT");
    expect(parsed.totalRows).toBe(1);
    expect(parsed.lines).toHaveLength(1);
  });

  it("keeps the good rows and reports the bad ones by number", async () => {
    const rows = await rowsOf("Date,Debit,Credit\n01/11/2026,100,\n99/99/2026,100,\n03/11/2026,abc,\n04/11/2026,200,\n");
    const parsed = parseStatement(rows, map({}), "BDT");
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.failedRows).toBe(2);
    expect(parsed.errors).toEqual([{ row: 3, code: "INVALID_DATE" }, { row: 4, code: "INVALID_AMOUNT" }]);
  });

  it("names a column that isn't in the file", async () => {
    const rows = await rowsOf("Date,Debit\n01/11/2026,100\n");
    expect(() => parseStatement(rows, map({ creditColumn: "Deposit" }), "BDT")).toThrow(StatementFileError);
  });

  it("finds columns whatever their case or spacing", async () => {
    const rows = await rowsOf(" DATE , debit ,CREDIT\n01/11/2026,100,\n");
    expect(parseStatement(rows, map({}), "BDT").lines).toHaveLength(1);
  });

  it("notices when a balance doesn't follow, oldest first or newest first", async () => {
    const good = await rowsOf("Date,Debit,Credit,Balance\n02/11/2026,300,,700\n01/11/2026,,1000,1000\n");
    expect(parseStatement(good, map({ balanceColumn: "Balance" }), "BDT").balanceBreaks).toBe(0);
    const bad = await rowsOf("Date,Debit,Credit,Balance\n01/11/2026,,1000,1000\n02/11/2026,300,,999\n03/11/2026,100,,800\n");
    expect(parseStatement(bad, map({ balanceColumn: "Balance" }), "BDT").balanceBreaks).toBeGreaterThan(0);
  });

  it("a mapping must say where the amount is", () => {
    expect(statementMapping.safeParse({ dateColumn: "Date", dateFormat: "DD/MM/YYYY" }).success).toBe(false);
    expect(statementMapping.safeParse({ dateColumn: "Date", dateFormat: "DD/MM/YYYY", amountColumn: "A", debitColumn: "B" }).success).toBe(false);
  });
});

describe("spotting repeats", () => {
  const line = (extra: object = {}) => ({ txnDate: "2026-11-05", direction: "OUT" as const, amountMinor: 50000n, feeMinor: 0n, balanceAfterMinor: null, description: null, reference: null, counterparty: null, providerTxnId: null, ...extra });

  it("two identical rows are both real, and the same file again matches both", () => {
    const first = fileDedupeHashes([line(), line()]);
    expect(first[0]).not.toBe(first[1]);
    expect(fileDedupeHashes([line(), line()])).toEqual(first);
  });

  it("a different amount, date, side or reference is a different row", () => {
    const [base] = fileDedupeHashes([line()]);
    for (const change of [{ amountMinor: 1n }, { txnDate: "2026-11-06" }, { direction: "IN" as const }, { reference: "R1" }]) {
      expect(fileDedupeHashes([line(change)])[0]).not.toBe(base);
    }
  });
});

describe("suggesting a mapping", () => {
  it("finds the header row and columns, and which date formats fit", async () => {
    const rows = await rowsOf("City Bank,,,,\nDate,Particulars,Withdrawal,Deposit,Balance\n25/11/2026,Rent,100,,900\n");
    const { suggestion, dateFormats } = suggestMapping(rows);
    expect(suggestion).toMatchObject({ headerRow: 2, dateColumn: "Date", descriptionColumn: "Particulars", debitColumn: "Withdrawal", creditColumn: "Deposit", balanceColumn: "Balance" });
    expect(dateFormats).toEqual(["DD/MM/YYYY"]);
  });

  it("offers both readings of an ambiguous date, rather than guessing", async () => {
    const { dateFormats } = suggestMapping(await rowsOf("Date,Amount\n05/06/2026,100\n"));
    expect(dateFormats).toEqual(expect.arrayContaining(["DD/MM/YYYY", "MM/DD/YYYY"]));
  });

  it("understands Bangla headings", async () => {
    const { suggestion } = suggestMapping(await rowsOf("তারিখ,বিবরণ,জমা,উত্তোলন,ব্যালেন্স\n05/11/2026,ভাড়া,,100,900\n"));
    expect(suggestion).toMatchObject({ dateColumn: "তারিখ", descriptionColumn: "বিবরণ", creditColumn: "জমা", debitColumn: "উত্তোলন", balanceColumn: "ব্যালেন্স" });
  });
});
