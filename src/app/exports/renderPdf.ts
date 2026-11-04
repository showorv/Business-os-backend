import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer";
import { env } from "../config/env.config.js";
import { formatMoney } from "../utils/money.js";
import type { Cell, ExportOptions, ReportRow, ReportTable } from "./reportTable.js";

// A real browser lays out the page, because simple PDF libraries break Bangla conjuncts (যুক্তাক্ষর).
// The fonts are embedded, so a PDF looks the same on any server, with no fonts installed.

const require = createRequire(import.meta.url);

const fontFace = (subset: string, weight: number) => {
  const path = require.resolve(`@fontsource/noto-sans-bengali/files/noto-sans-bengali-${subset}-${weight}-normal.woff2`);
  const data = readFileSync(path).toString("base64");
  return `@font-face { font-family: "Report ${subset}"; font-weight: ${weight}; src: url(data:font/woff2;base64,${data}) format("woff2"); }`;
};

let cachedFonts: string | null = null;
const fontStyles = () => {
  cachedFonts ??= ["latin", "bengali"].flatMap((subset) => [400, 700].map((weight) => fontFace(subset, weight))).join("\n");
  return cachedFonts;
};

// Account names and business names are user-typed, so everything is escaped.
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const toHtmlCell = (cell: Cell, table: ReportTable, options: ExportOptions) => {
  if (cell === null) return "";
  if (typeof cell === "bigint") {
    return escapeHtml(formatMoney(cell, table.currency, { digitStyle: options.digitStyle, grouping: options.grouping }));
  }
  return escapeHtml(cell);
};

const toHtmlRow = (row: ReportRow, table: ReportTable, options: ExportOptions) => {
  const cells = row.cells
    .map((cell, index) => `<td class="${table.columns[index]?.numeric ? "num" : ""}">${toHtmlCell(cell, table, options)}</td>`)
    .join("");
  return `<tr class="${row.kind}">${cells}</tr>`;
};

const toHtml = (table: ReportTable, options: ExportOptions) => `<!doctype html>
<html lang="${options.locale === "bn-BD" ? "bn" : "en"}">
<head>
<meta charset="utf-8">
<style>
${fontStyles()}
body { font-family: "Report bengali", "Report latin", sans-serif; font-size: 11px; color: #111; line-height: 1.6; }
h1 { font-size: 18px; margin: 0; }
h2 { font-size: 14px; margin: 2px 0; font-weight: 400; }
.meta { color: #555; margin: 0 0 16px; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; border-bottom: 1.5px solid #111; padding: 5px 6px; }
td { padding: 4px 6px; border-bottom: 0.5px solid #ddd; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
tr.section td { font-weight: 700; padding-top: 12px; border-bottom: 1px solid #999; }
tr.total td { font-weight: 700; border-top: 1px solid #111; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
</style>
</head>
<body>
<h1>${escapeHtml(table.businessName)}</h1>
<h2>${escapeHtml(table.title)}</h2>
<p class="meta">${escapeHtml(table.period)} · ${escapeHtml(table.note)}</p>
<table>
<thead><tr>${table.columns.map((column) => `<th class="${column.numeric ? "num" : ""}">${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
<tbody>${table.rows.map((row) => toHtmlRow(row, table, options)).join("")}</tbody>
</table>
</body>
</html>`;

export const renderPdf = async (table: ReportTable, options: ExportOptions) => {
  const browser = await puppeteer.launch({ headless: true, args: env.CHROME_NO_SANDBOX ? ["--no-sandbox"] : [] });
  try {
    const page = await browser.newPage();

    // The page only ever contains our own template, so nothing should run or load from outside.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("data:") || url === "about:blank") void request.continue();
      else void request.abort();
    });

    await page.setContent(toHtml(table, options), { waitUntil: "load" });
    await page.evaluateHandle("document.fonts.ready");
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "18mm", bottom: "18mm", left: "14mm", right: "14mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
};
