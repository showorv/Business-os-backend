import ExcelJS from "exceljs";
import { toDecimalString } from "../utils/money.js";
import type { Cell, ReportTable } from "./reportTable.js";

const NUMBER_FORMAT = "#,##0.00;[Red]-#,##0.00";

// A real number, so people can add it up in Excel. An amount too big for that stays text, because
// an exact figure matters more than a sum.
const toCellValue = (cell: Cell, currency: string) => {
  if (typeof cell !== "bigint") return cell;
  const decimal = toDecimalString(cell, currency);
  const isExact = cell <= BigInt(Number.MAX_SAFE_INTEGER) && cell >= BigInt(Number.MIN_SAFE_INTEGER);
  return isExact ? Number(decimal) : decimal;
};

export const renderXlsx = async (table: ReportTable) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(table.title.slice(0, 31).replace(/[*?:\\/[\]]/g, " "));

  const heading = (text: string, bold: boolean) => {
    const row = sheet.addRow([text]);
    row.font = { bold, size: bold ? 14 : 11 };
  };
  heading(table.businessName, true);
  heading(table.title, true);
  heading(table.period, false);
  heading(table.note, false);
  sheet.addRow([]);

  const header = sheet.addRow(table.columns.map((column) => column.label));
  header.font = { bold: true };

  for (const reportRow of table.rows) {
    const row = sheet.addRow(reportRow.cells.map((cell) => toCellValue(cell, table.currency)));
    if (reportRow.kind !== "item") row.font = { bold: true };
  }

  table.columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);
    sheetColumn.width = column.numeric ? 18 : index === 0 ? 10 : 36;
    if (column.numeric) sheetColumn.numFmt = NUMBER_FORMAT;
    if (column.numeric) sheetColumn.alignment = { horizontal: "right" };
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
};
