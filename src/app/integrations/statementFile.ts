import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { z } from "zod";
import { sha256Hex } from "../utils/crypto.js";
import { minorDigitsOf } from "../utils/money.js";
import { normalizeDigits } from "../utils/normalize.js";
import type { CanonicalLine } from "./adapter.js";

export const MAX_STATEMENT_ROWS = 50_000;
const MAX_REPORTED_ERRORS = 50;
const MAX_TEXT_LENGTH = 500;
const HEADER_SEARCH_ROWS = 30;

export const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD-MM-YYYY", "DD-MMM-YYYY", "DD.MM.YYYY", "YYYY/MM/DD", "DD MMM YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const columnName = z.string().trim().min(1).max(200);

// Columns are named by their heading, because banks reorder and add columns over time.
export const statementMapping = z
  .object({
    headerRow: z.number().int().min(1).max(HEADER_SEARCH_ROWS).default(1),
    dateColumn: columnName,
    dateFormat: z.enum(DATE_FORMATS),
    descriptionColumn: columnName.optional(),
    referenceColumn: columnName.optional(),
    counterpartyColumn: columnName.optional(),
    // Either one amount column, negative for money out, or a Dr/Cr column beside it...
    amountColumn: columnName.optional(),
    directionColumn: columnName.optional(),
    // ...or separate money-out and money-in columns.
    debitColumn: columnName.optional(),
    creditColumn: columnName.optional(),
    feeColumn: columnName.optional(),
    balanceColumn: columnName.optional(),
  })
  .refine((mapping) => Boolean(mapping.amountColumn) !== Boolean(mapping.debitColumn || mapping.creditColumn), {
    message: "AMOUNT_OR_DEBIT_CREDIT_REQUIRED",
  })
  .refine((mapping) => !mapping.directionColumn || Boolean(mapping.amountColumn), { message: "DIRECTION_NEEDS_AMOUNT" });

export type StatementMapping = z.infer<typeof statementMapping>;

export class StatementFileError extends Error {
  constructor(
    public readonly code: "UNREADABLE" | "TOO_MANY_ROWS" | "COLUMN_MISSING",
    public readonly detail?: string,
  ) {
    super(code);
    this.name = "StatementFileError";
  }
}

type Row = string[];

const cellToText = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) return "";
  // A date cell has no format of its own to read, so it's written in one the date parser knows.
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return cellToText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
    return "";
  }
  return String(value);
};

const decodeCsv = (bytes: Buffer) => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  return bytes.toString("utf8");
};

const readCsv = (bytes: Buffer): Row[] => {
  try {
    return parse(decodeCsv(bytes), {
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      delimiter: [",", ";", "\t"],
      to_line: MAX_STATEMENT_ROWS + HEADER_SEARCH_ROWS + 1,
    }) as Row[];
  } catch {
    throw new StatementFileError("UNREADABLE");
  }
};

const readXlsx = async (bytes: Buffer): Promise<Row[]> => {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new StatementFileError("UNREADABLE");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new StatementFileError("UNREADABLE");

  const rows: Row[] = [];
  sheet.eachRow((row) => {
    if (rows.length > MAX_STATEMENT_ROWS + HEADER_SEARCH_ROWS) return;
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cells[column - 1] = cellToText(cell.value);
    });
    rows.push(Array.from(cells, (cell) => cell ?? ""));
  });
  return rows;
};

export const readStatementRows = (bytes: Buffer, mime: string) => (mime === "text/csv" ? Promise.resolve(readCsv(bytes)) : readXlsx(bytes));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const PATTERNS: Record<DateFormat, RegExp> = {
  "DD/MM/YYYY": /^(?<d>\d{1,2})\/(?<m>\d{1,2})\/(?<y>\d{4})/,
  "MM/DD/YYYY": /^(?<m>\d{1,2})\/(?<d>\d{1,2})\/(?<y>\d{4})/,
  "YYYY-MM-DD": /^(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})/,
  "DD-MM-YYYY": /^(?<d>\d{1,2})-(?<m>\d{1,2})-(?<y>\d{4})/,
  "DD-MMM-YYYY": /^(?<d>\d{1,2})-(?<mon>[a-z]{3})[a-z]*-(?<y>\d{4})/i,
  "DD.MM.YYYY": /^(?<d>\d{1,2})\.(?<m>\d{1,2})\.(?<y>\d{4})/,
  "YYYY/MM/DD": /^(?<y>\d{4})\/(?<m>\d{1,2})\/(?<d>\d{1,2})/,
  "DD MMM YYYY": /^(?<d>\d{1,2}) (?<mon>[a-z]{3})[a-z]* (?<y>\d{4})/i,
};

// Returns YYYY-MM-DD, or null if it isn't a real date in this format. A time after the date is ignored.
export const parseStatementDate = (text: string, format: DateFormat) => {
  const value = normalizeDigits(text).trim();
  // A real Excel date cell always arrives as YYYY-MM-DD, whatever format was chosen for the text rows.
  const groups = (PATTERNS[format].exec(value) ?? PATTERNS["YYYY-MM-DD"].exec(value))?.groups;
  if (!groups) return null;

  const month = groups.mon ? MONTHS.indexOf(groups.mon.toLowerCase()) + 1 : Number(groups.m);
  const date = new Date(Date.UTC(Number(groups.y), month - 1, Number(groups.d)));
  if (month < 1 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== Number(groups.d)) return null;
  return date.toISOString().slice(0, 10);
};

const AMOUNT_NOISE = /[\s,৳$£€₹]|BDT|TK\.?|USD/gi;

// Whole minor units as a BigInt. Never goes through a float. Returns null if it isn't a number.
export const parseStatementAmount = (text: string, currency: string) => {
  let value = normalizeDigits(text).replace(AMOUNT_NOISE, "");
  if (value === "" || value === "-") return null;

  let sign = 1n;
  const suffix = /(DR|CR)\.?$/i.exec(value);
  if (suffix) {
    value = value.slice(0, suffix.index);
    if (suffix[1]!.toUpperCase() === "DR") sign = -1n;
  }
  if (/^\(.*\)$/.test(value)) {
    sign = -sign;
    value = value.slice(1, -1);
  }
  if (value.endsWith("-")) {
    sign = -sign;
    value = value.slice(0, -1);
  } else if (value.startsWith("-")) {
    sign = -sign;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }

  const parts = /^(\d*)(?:\.(\d*))?$/.exec(value);
  if (!parts || (!parts[1] && !parts[2])) return null;

  const digits = minorDigitsOf(currency);
  const fraction = parts[2] ?? "";
  // Paisa beyond what the currency has must be zeros. Otherwise rounding would change the amount.
  if (/[1-9]/.test(fraction.slice(digits))) return null;
  return sign * BigInt(`${parts[1] || "0"}${fraction.slice(0, digits).padEnd(digits, "0")}`);
};

const cleanText = (text: string | undefined) => {
  const value = text?.normalize("NFC").trim();
  return value ? value.slice(0, MAX_TEXT_LENGTH) : null;
};

const headerKey = (text: string) => text.normalize("NFC").trim().toLowerCase();

export interface RowError {
  row: number;
  code: "INVALID_DATE" | "INVALID_AMOUNT" | "NO_AMOUNT";
}

export interface ParsedStatement {
  totalRows: number;
  lines: CanonicalLine[];
  errors: RowError[];
  failedRows: number;
  balanceBreaks: number;
}

// How many rows' balance doesn't follow from the row before. Banks list either oldest or newest first,
// so whichever order fits better is taken as the real one.
const countBalanceBreaks = (lines: CanonicalLine[]) => {
  const signed = (line: CanonicalLine) => (line.direction === "IN" ? line.amountMinor : -line.amountMinor);
  let oldestFirst = 0;
  let newestFirst = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const current = lines[index]!;
    if (previous.balanceAfterMinor === null || current.balanceAfterMinor === null) continue;
    if (previous.balanceAfterMinor + signed(current) !== current.balanceAfterMinor) oldestFirst += 1;
    if (current.balanceAfterMinor + signed(previous) !== previous.balanceAfterMinor) newestFirst += 1;
  }
  return Math.min(oldestFirst, newestFirst);
};

// Applies a mapping to the rows. One bad row doesn't stop the others: it is reported instead.
export const parseStatement = (rows: Row[], mapping: StatementMapping, currency: string): ParsedStatement => {
  const headers = (rows[mapping.headerRow - 1] ?? []).map(headerKey);
  const indexOf = (column: string | undefined) => {
    if (!column) return -1;
    const index = headers.indexOf(headerKey(column));
    if (index < 0) throw new StatementFileError("COLUMN_MISSING", column);
    return index;
  };

  const date = indexOf(mapping.dateColumn);
  const description = indexOf(mapping.descriptionColumn);
  const reference = indexOf(mapping.referenceColumn);
  const counterparty = indexOf(mapping.counterpartyColumn);
  const amount = indexOf(mapping.amountColumn);
  const directionColumn = indexOf(mapping.directionColumn);
  const debit = indexOf(mapping.debitColumn);
  const credit = indexOf(mapping.creditColumn);
  const fee = indexOf(mapping.feeColumn);
  const balance = indexOf(mapping.balanceColumn);

  const dataRows = rows.slice(mapping.headerRow);
  if (dataRows.length > MAX_STATEMENT_ROWS) throw new StatementFileError("TOO_MANY_ROWS");

  const lines: CanonicalLine[] = [];
  const errors: RowError[] = [];
  let failedRows = 0;
  let totalRows = 0;

  const fail = (row: number, code: RowError["code"]) => {
    failedRows += 1;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ row, code });
  };
  const cell = (row: Row, index: number) => (index >= 0 ? (row[index] ?? "") : "");

  dataRows.forEach((row, offset) => {
    const rowNumber = mapping.headerRow + offset + 1;
    const dateText = cell(row, date).trim();
    const rawAmounts = [cell(row, amount), cell(row, debit), cell(row, credit)].map((text) => text.trim());
    const hasAmount = rawAmounts.some((text) => text !== "");

    // Blank rows and footers such as "Closing balance" are not transactions.
    if (!hasAmount && !parseStatementDate(dateText, mapping.dateFormat)) return;
    totalRows += 1;

    const txnDate = parseStatementDate(dateText, mapping.dateFormat);
    if (!txnDate) return fail(rowNumber, "INVALID_DATE");

    let signed: bigint | null;
    if (amount >= 0) {
      signed = parseStatementAmount(rawAmounts[0]!, currency);
      if (signed !== null && directionColumn >= 0) {
        const flag = cell(row, directionColumn).trim().toLowerCase();
        const absolute = signed < 0n ? -signed : signed;
        signed = /^(dr|debit|withdraw|out)/.test(flag) ? -absolute : absolute;
      }
    } else {
      const out = rawAmounts[1] ? parseStatementAmount(rawAmounts[1], currency) : 0n;
      const inward = rawAmounts[2] ? parseStatementAmount(rawAmounts[2], currency) : 0n;
      signed = out === null || inward === null ? null : inward - (out < 0n ? -out : out);
    }
    if (signed === null) return fail(rowNumber, "INVALID_AMOUNT");
    if (signed === 0n) return fail(rowNumber, "NO_AMOUNT");

    const feeValue = fee >= 0 ? parseStatementAmount(cell(row, fee), currency) : 0n;
    lines.push({
      txnDate,
      direction: signed > 0n ? "IN" : "OUT",
      amountMinor: signed > 0n ? signed : -signed,
      feeMinor: feeValue !== null && feeValue > 0n ? feeValue : 0n,
      balanceAfterMinor: balance >= 0 ? parseStatementAmount(cell(row, balance), currency) : null,
      description: cleanText(cell(row, description)),
      reference: cleanText(cell(row, reference)),
      counterparty: cleanText(cell(row, counterparty)),
      providerTxnId: null,
    });
  });

  return { totalRows, lines, errors, failedRows, balanceBreaks: countBalanceBreaks(lines) };
};

// Two identical rows in one statement are both real (two ৳500 withdrawals on one day), so each repeat
// gets a counter. The same file imported again produces the same hashes, and adds nothing.
export const fileDedupeHashes = (lines: CanonicalLine[]) => {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const key = [line.txnDate, line.direction, line.amountMinor, line.reference ?? "", line.balanceAfterMinor ?? ""].join("|");
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return sha256Hex(`${key}|${occurrence}`);
  });
};

const COLUMN_HINTS: [keyof StatementMapping, RegExp][] = [
  ["dateColumn", /^(txn |trans(action)? |value |post(ing)? )?date$|তারিখ/i],
  ["descriptionColumn", /description|particular|narration|details|remarks|বিবরণ/i],
  ["referenceColumn", /ref|cheque|chq|trx ?id|txn ?id|transaction id|রেফারেন্স/i],
  ["counterpartyColumn", /counterparty|sender|receiver|payee|beneficiary/i],
  ["debitColumn", /debit|withdraw|money out|^dr$|উত্তোলন|ডেবিট/i],
  ["creditColumn", /credit|deposit|money in|^cr$|জমা|ক্রেডিট/i],
  ["balanceColumn", /balance|ব্যালেন্স|স্থিতি/i],
  ["feeColumn", /\bfee\b|charge/i],
  ["amountColumn", /^amount|^টাকা|পরিমাণ/i],
];

// A first guess at the mapping, for a person to check in the preview. It never imports by itself.
export const suggestMapping = (rows: Row[]) => {
  let best = { row: 0, score: 0 };
  rows.slice(0, HEADER_SEARCH_ROWS).forEach((row, index) => {
    const score = COLUMN_HINTS.filter(([, hint]) => row.some((cell) => hint.test(cell.trim()))).length;
    if (score > best.score) best = { row: index, score };
  });

  const headers = rows[best.row] ?? [];
  const suggestion: Partial<Record<keyof StatementMapping, string | number>> = { headerRow: best.row + 1 };
  for (const [field, hint] of COLUMN_HINTS) {
    const match = headers.find((header) => hint.test(header.trim()));
    if (match) suggestion[field] = match.trim();
  }
  if (suggestion.debitColumn || suggestion.creditColumn) delete suggestion.amountColumn;

  const dateIndex = headers.findIndex((header) => header.trim() === suggestion.dateColumn);
  const samples = rows.slice(best.row + 1, best.row + 21).map((row) => row[dateIndex] ?? "").filter((text) => text.trim());
  const dateFormats = DATE_FORMATS.filter((format) => samples.length > 0 && samples.every((text) => parseStatementDate(text, format)));

  return { headers: headers.map((header) => header.trim()), suggestion, dateFormats };
};
