import { formatDate } from "../utils/dates.js";
import { formatMoney, type MoneyFormat } from "../utils/money.js";
import { escapeHtml, fontStyles, htmlToPdf } from "./renderPdf.js";

// What an invoice or bill PDF shows. Everything typed by people is escaped before it reaches the page.
export interface InvoiceDocument {
  kind: "SALE" | "BILL";
  number: string | null;
  status: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  totalMinor: bigint;
  paidMinor: bigint;
  referenceNo: string | null;
  notes: string | null;
  business: { name: string; legalName: string | null; taxId: string | null };
  contact: { name: string; company: string | null; address: string | null; phone: string | null; email: string | null; taxId: string | null };
  lines: { description: string; quantity: string; unitPriceMinor: bigint; amountMinor: bigint }[];
}

export interface InvoiceFormat {
  locale: "en" | "bn-BD";
  grouping: MoneyFormat["grouping"];
}

const LABELS = {
  en: {
    SALE: "Invoice",
    BILL: "Bill",
    draft: "Draft",
    void: "Void",
    billTo: "Bill to",
    from: "From",
    issued: "Issue date",
    due: "Due date",
    reference: "Reference",
    taxId: "BIN/TIN",
    description: "Description",
    quantity: "Qty",
    price: "Unit price",
    amount: "Amount",
    total: "Total",
    paid: "Paid",
    balance: "Balance due",
    notes: "Notes",
  },
  "bn-BD": {
    SALE: "চালান",
    BILL: "বিল",
    draft: "খসড়া",
    void: "বাতিল",
    billTo: "প্রাপক",
    from: "প্রেরক",
    issued: "তারিখ",
    due: "পরিশোধের শেষ তারিখ",
    reference: "রেফারেন্স",
    taxId: "BIN/TIN",
    description: "বিবরণ",
    quantity: "পরিমাণ",
    price: "একক মূল্য",
    amount: "মোট",
    total: "সর্বমোট",
    paid: "পরিশোধিত",
    balance: "বাকি",
    notes: "নোট",
  },
} as const;

const toBangla = (text: string) => text.replace(/\d/g, (digit) => String.fromCharCode(0x09e6 + Number(digit)));

const toHtml = (doc: InvoiceDocument, format: InvoiceFormat) => {
  const label = LABELS[format.locale];
  const bangla = format.locale === "bn-BD";
  const money = (amount: bigint) =>
    escapeHtml(formatMoney(amount, doc.currency, { digitStyle: bangla ? "bangla" : "latin", grouping: format.grouping }));
  const day = (iso: string) => escapeHtml(formatDate(iso, format.locale, bangla ? "bangla" : "latin"));
  const digits = (text: string) => escapeHtml(bangla ? toBangla(text) : text);
  const lines = (...parts: (string | null)[]) => parts.filter(Boolean).map((part) => escapeHtml(part!)).join("<br>");

  // On a bill the supplier is the sender and the business receives it.
  const party = (who: InvoiceDocument["contact"]) =>
    `<strong>${escapeHtml(who.name)}</strong>${who.company ? `<br>${escapeHtml(who.company)}` : ""}` +
    (who.address || who.phone || who.email ? `<br>${lines(who.address, who.phone, who.email)}` : "") +
    (who.taxId ? `<br>${label.taxId}: ${escapeHtml(who.taxId)}` : "");
  const businessParty = `<strong>${escapeHtml(doc.business.legalName ?? doc.business.name)}</strong>` +
    (doc.business.taxId ? `<br>${label.taxId}: ${escapeHtml(doc.business.taxId)}` : "");

  const stamp = doc.status === "DRAFT" ? label.draft : doc.status === "VOID" ? label.void : null;

  return `<!doctype html>
<html lang="${bangla ? "bn" : "en"}">
<head>
<meta charset="utf-8">
<style>
${fontStyles()}
body { font-family: "Report bengali", "Report latin", sans-serif; font-size: 11px; color: #111; line-height: 1.6; }
.head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
h1 { font-size: 22px; margin: 0; letter-spacing: 0.02em; }
.number { font-size: 13px; color: #444; }
.stamp { display: inline-block; border: 1.5px solid #111; padding: 2px 10px; font-weight: 700; text-transform: uppercase; margin-top: 6px; }
.parties { display: flex; gap: 32px; margin-bottom: 20px; }
.parties > div { flex: 1; }
.caption { color: #666; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 2px; }
.meta td { padding: 1px 12px 1px 0; border: 0; }
table.items { width: 100%; border-collapse: collapse; margin-top: 8px; }
.items th { text-align: left; border-bottom: 1.5px solid #111; padding: 5px 6px; }
.items td { padding: 5px 6px; border-bottom: 0.5px solid #ddd; vertical-align: top; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sum { width: 45%; margin-left: auto; margin-top: 12px; border-collapse: collapse; }
.sum td { padding: 3px 6px; }
.sum tr.strong td { font-weight: 700; border-top: 1px solid #111; font-size: 12px; }
.notes { margin-top: 24px; white-space: pre-wrap; }
tr { page-break-inside: avoid; }
</style>
</head>
<body>
<div class="head">
  <div>
    <h1>${label[doc.kind]}</h1>
    <div class="number">${escapeHtml(doc.number ?? "")}</div>
    ${stamp ? `<div class="stamp">${stamp}</div>` : ""}
  </div>
  <table class="meta">
    <tr><td class="caption">${label.issued}</td><td>${day(doc.issueDate)}</td></tr>
    <tr><td class="caption">${label.due}</td><td>${day(doc.dueDate)}</td></tr>
    ${doc.referenceNo ? `<tr><td class="caption">${label.reference}</td><td>${escapeHtml(doc.referenceNo)}</td></tr>` : ""}
  </table>
</div>
<div class="parties">
  <div><div class="caption">${label.from}</div>${doc.kind === "SALE" ? businessParty : party(doc.contact)}</div>
  <div><div class="caption">${label.billTo}</div>${doc.kind === "SALE" ? party(doc.contact) : businessParty}</div>
</div>
<table class="items">
<thead><tr><th>${label.description}</th><th class="num">${label.quantity}</th><th class="num">${label.price}</th><th class="num">${label.amount}</th></tr></thead>
<tbody>
${doc.lines
  .map(
    (line) =>
      `<tr><td>${escapeHtml(line.description)}</td><td class="num">${digits(line.quantity)}</td><td class="num">${money(line.unitPriceMinor)}</td><td class="num">${money(line.amountMinor)}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>
<table class="sum">
  <tr class="strong"><td>${label.total}</td><td class="num">${money(doc.totalMinor)}</td></tr>
  ${doc.paidMinor > 0n ? `<tr><td>${label.paid}</td><td class="num">${money(doc.paidMinor)}</td></tr>` : ""}
  ${doc.status !== "VOID" ? `<tr class="strong"><td>${label.balance}</td><td class="num">${money(doc.totalMinor - doc.paidMinor)}</td></tr>` : ""}
</table>
${doc.notes ? `<div class="notes"><div class="caption">${label.notes}</div>${escapeHtml(doc.notes)}</div>` : ""}
</body>
</html>`;
};

export const renderInvoicePdf = (doc: InvoiceDocument, format: InvoiceFormat) => htmlToPdf(toHtml(doc, format));
