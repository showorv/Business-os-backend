import ExcelJS from "exceljs";
import { toDecimalString } from "../utils/money.js";

// A workbook of plain tables, one sheet each, for taking a business's data elsewhere.
// Money arrives in minor units and becomes a real number (or exact text when too big for one).
// Dates are real dates, so they sort and filter in Excel, Numbers and Google Sheets.
export type SheetCell = string | number | bigint | boolean | Date | null;

export interface SheetColumn {
  label: string;
  money?: boolean;
  // "day": a date. "time": a date and time, already moved into the business's timezone.
  date?: "day" | "time";
  width?: number;
}

export interface Sheet {
  name: string;
  columns: SheetColumn[];
  rows: SheetCell[][];
  // A sheet of notes rather than a table: no filter buttons, no frozen header.
  notes?: boolean;
}

const MONEY_FORMAT = "#,##0.00;[Red]-#,##0.00";
const DAY_FORMAT = "dd mmm yyyy";
const TIME_FORMAT = "dd mmm yyyy hh:mm";

const toValue = (cell: SheetCell, money: boolean, currency: string) => {
  if (cell === null) return null;
  if (typeof cell === "bigint") {
    if (!money) return Number(cell);
    const decimal = toDecimalString(cell, currency);
    const exact = cell <= BigInt(Number.MAX_SAFE_INTEGER) && cell >= BigInt(Number.MIN_SAFE_INTEGER);
    return exact ? Number(decimal) : decimal;
  }
  if (typeof cell === "boolean") return cell ? "Yes" : "No";
  return cell;
};

export const renderWorkbook = async (sheets: Sheet[], currency: string) => {
  const workbook = new ExcelJS.Workbook();
  for (const table of sheets) {
    const sheet = workbook.addWorksheet(table.name.slice(0, 31).replace(/[*?:\\/[\]]/g, " "), {
      views: table.notes ? [] : [{ state: "frozen", ySplit: 1 }],
    });
    const header = sheet.addRow(table.columns.map((column) => column.label));
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } };
      cell.border = { bottom: { style: "thin", color: { argb: "FF999999" } } };
    });
    for (const row of table.rows) sheet.addRow(row.map((cell, index) => toValue(cell, table.columns[index]?.money === true, currency)));
    table.columns.forEach((column, index) => {
      const sheetColumn = sheet.getColumn(index + 1);
      sheetColumn.width = column.width ?? (column.money ? 16 : column.date === "time" ? 20 : column.date ? 14 : 22);
      if (column.money) sheetColumn.numFmt = MONEY_FORMAT;
      if (column.date) sheetColumn.numFmt = column.date === "time" ? TIME_FORMAT : DAY_FORMAT;
      if (!column.money && !column.date) sheetColumn.alignment = { wrapText: true, vertical: "top" };
    });
    // Sort and filter buttons on the header.
    if (!table.notes && table.rows.length > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
};
