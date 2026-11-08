import ExcelJS from "exceljs";
import { toDecimalString } from "../utils/money.js";

// A workbook of plain tables, one sheet each, for taking a business's data elsewhere.
// Money arrives in minor units and becomes a real number (or exact text when too big for one).
export type SheetCell = string | number | bigint | boolean | null;

export interface SheetColumn {
  label: string;
  money?: boolean;
  width?: number;
}

export interface Sheet {
  name: string;
  columns: SheetColumn[];
  rows: SheetCell[][];
}

const MONEY_FORMAT = "#,##0.00;[Red]-#,##0.00";

const toValue = (cell: SheetCell, money: boolean, currency: string) => {
  if (cell === null) return null;
  if (typeof cell === "bigint") {
    if (!money) return Number(cell);
    const decimal = toDecimalString(cell, currency);
    const exact = cell <= BigInt(Number.MAX_SAFE_INTEGER) && cell >= BigInt(Number.MIN_SAFE_INTEGER);
    return exact ? Number(decimal) : decimal;
  }
  if (typeof cell === "boolean") return cell ? "yes" : "no";
  return cell;
};

export const renderWorkbook = async (sheets: Sheet[], currency: string) => {
  const workbook = new ExcelJS.Workbook();
  for (const table of sheets) {
    const sheet = workbook.addWorksheet(table.name.slice(0, 31).replace(/[*?:\\/[\]]/g, " "), { views: [{ state: "frozen", ySplit: 1 }] });
    const header = sheet.addRow(table.columns.map((column) => column.label));
    header.font = { bold: true };
    for (const row of table.rows) sheet.addRow(row.map((cell, index) => toValue(cell, table.columns[index]?.money === true, currency)));
    table.columns.forEach((column, index) => {
      const sheetColumn = sheet.getColumn(index + 1);
      sheetColumn.width = column.width ?? (column.money ? 16 : 22);
      if (column.money) sheetColumn.numFmt = MONEY_FORMAT;
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
};
