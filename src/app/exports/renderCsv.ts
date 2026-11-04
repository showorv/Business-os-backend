import { toDecimalString } from "../utils/money.js";
import type { Cell, ReportTable } from "./reportTable.js";

// Without this mark, Excel opens UTF-8 as gibberish and Bangla is unreadable.
const UTF8_BOM = "﻿";

// A spreadsheet runs a cell starting with these as a formula, and names are user-typed text.
const FORMULA_START = /^[=+\-@\t\r]/;

const textCell = (value: string) => {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const toField = (cell: Cell, currency: string) => {
  if (cell === null) return "";
  return typeof cell === "bigint" ? toDecimalString(cell, currency) : textCell(cell);
};

export const renderCsv = (table: ReportTable) => {
  const lines = [
    table.columns.map((column) => textCell(column.label)).join(","),
    ...table.rows.map((row) => row.cells.map((cell) => toField(cell, table.currency)).join(",")),
  ];
  return Buffer.from(`${UTF8_BOM}${lines.join("\r\n")}\r\n`, "utf8");
};
