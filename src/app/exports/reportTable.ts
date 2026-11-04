import { formatDate } from "../utils/dates.js";

// Every export format renders this one shape, so a report only has to be described once.
// A money cell stays a bigint here; each renderer decides how to write it.
export type Cell = string | bigint | null;

export interface ReportRow {
  kind: "section" | "item" | "total";
  cells: Cell[];
}

export interface ReportTable {
  title: string;
  businessName: string;
  period: string;
  note: string;
  currency: string;
  columns: { label: string; numeric: boolean }[];
  rows: ReportRow[];
}

export interface ExportOptions {
  businessName: string;
  locale: "en" | "bn-BD";
  digitStyle: "latin" | "bangla";
  grouping: "lakh" | "western";
}

const LABELS = {
  en: {
    TRIAL_BALANCE: "Trial Balance",
    PROFIT_AND_LOSS: "Profit & Loss",
    BALANCE_SHEET: "Balance Sheet",
    CASH_FLOW: "Cash Flow Statement",
    asOf: "As of",
    to: "to",
    code: "Code",
    account: "Account",
    debit: "Debit",
    credit: "Credit",
    amount: "Amount",
    total: "Total",
    revenue: "Revenue",
    expenses: "Expenses",
    netProfit: "Net profit",
    assets: "Assets",
    liabilities: "Liabilities",
    equity: "Equity",
    unclosedProfit: "Profit not yet closed",
    liabilitiesAndEquity: "Total liabilities and equity",
    beginningCash: "Cash at the start",
    openingBalances: "Opening balances added",
    operating: "Operating activities",
    investing: "Investing activities",
    financing: "Financing activities",
    netChange: "Net change in cash",
    endingCash: "Cash at the end",
    note: "Posted actuals from the ledger",
  },
  "bn-BD": {
    TRIAL_BALANCE: "ট্রায়াল ব্যালেন্স",
    PROFIT_AND_LOSS: "লাভ-ক্ষতি বিবরণী",
    BALANCE_SHEET: "ব্যালেন্স শিট",
    CASH_FLOW: "নগদ প্রবাহ বিবরণী",
    asOf: "তারিখ",
    to: "থেকে",
    code: "কোড",
    account: "হিসাব",
    debit: "ডেবিট",
    credit: "ক্রেডিট",
    amount: "পরিমাণ",
    total: "মোট",
    revenue: "আয়",
    expenses: "ব্যয়",
    netProfit: "নিট মুনাফা",
    assets: "সম্পদ",
    liabilities: "দায়",
    equity: "মালিকানা স্বত্ব",
    unclosedProfit: "অসমাপ্ত মুনাফা",
    liabilitiesAndEquity: "মোট দায় ও মালিকানা স্বত্ব",
    beginningCash: "শুরুর নগদ",
    openingBalances: "যোগ হওয়া প্রারম্ভিক ব্যালেন্স",
    operating: "পরিচালন কার্যক্রম",
    investing: "বিনিয়োগ কার্যক্রম",
    financing: "অর্থায়ন কার্যক্রম",
    netChange: "নগদের নিট পরিবর্তন",
    endingCash: "শেষের নগদ",
    note: "লেজারে পোস্ট করা প্রকৃত হিসাব",
  },
} as const;

interface Line {
  code: string;
  name: string;
  nameBn: string | null;
  amountMinor: bigint;
}

interface Section {
  items: Line[];
  totalMinor: bigint;
}

const base = (options: ExportOptions, currency: string) => {
  const labels = LABELS[options.locale];
  const date = (iso: string) => formatDate(iso, options.locale, options.digitStyle);
  const nameOf = (line: { name: string; nameBn: string | null }) => (options.locale === "bn-BD" && line.nameBn ? line.nameBn : line.name);
  const asOfLine = (iso: string) => `${labels.asOf}: ${date(iso)}`;
  const rangeLine = (from: string, to: string) =>
    options.locale === "bn-BD" ? `${date(from)} ${labels.to} ${date(to)}` : `${date(from)} ${labels.to} ${date(to)}`;
  return {
    labels,
    nameOf,
    asOfLine,
    rangeLine,
    shared: { businessName: options.businessName, note: `${labels.note} · ${currency}`, currency },
    amountColumns: [
      { label: labels.code, numeric: false },
      { label: labels.account, numeric: false },
      { label: labels.amount, numeric: true },
    ],
  };
};

const sectionRows = (title: string, section: Section, total: string, nameOf: (line: Line) => string): ReportRow[] => [
  { kind: "section", cells: [title, null, null] },
  ...section.items.map((line): ReportRow => ({ kind: "item", cells: [line.code, nameOf(line), line.amountMinor] })),
  { kind: "total", cells: [null, total, section.totalMinor] },
];

export const trialBalanceTable = (
  data: {
    asOf: string;
    currency: string;
    items: { code: string; name: string; nameBn: string | null; debitBalanceMinor: bigint; creditBalanceMinor: bigint }[];
    totalDebitMinor: bigint;
    totalCreditMinor: bigint;
  },
  options: ExportOptions,
): ReportTable => {
  const { labels, nameOf, asOfLine, shared } = base(options, data.currency);
  return {
    ...shared,
    title: labels.TRIAL_BALANCE,
    period: asOfLine(data.asOf),
    columns: [
      { label: labels.code, numeric: false },
      { label: labels.account, numeric: false },
      { label: labels.debit, numeric: true },
      { label: labels.credit, numeric: true },
    ],
    rows: [
      ...data.items.map((item): ReportRow => ({
        kind: "item",
        cells: [item.code, nameOf(item), item.debitBalanceMinor || null, item.creditBalanceMinor || null],
      })),
      { kind: "total", cells: [null, labels.total, data.totalDebitMinor, data.totalCreditMinor] },
    ],
  };
};

export const profitAndLossTable = (
  data: { from: string; to: string; currency: string; revenue: Section; expenses: Section; netProfitMinor: bigint },
  options: ExportOptions,
): ReportTable => {
  const { labels, nameOf, rangeLine, shared, amountColumns } = base(options, data.currency);
  return {
    ...shared,
    title: labels.PROFIT_AND_LOSS,
    period: rangeLine(data.from, data.to),
    columns: amountColumns,
    rows: [
      ...sectionRows(labels.revenue, data.revenue, labels.total, nameOf),
      ...sectionRows(labels.expenses, data.expenses, labels.total, nameOf),
      { kind: "total", cells: [null, labels.netProfit, data.netProfitMinor] },
    ],
  };
};

export const balanceSheetTable = (
  data: {
    asOf: string;
    currency: string;
    assets: Section;
    liabilities: Section;
    equity: Section & { unclosedProfitMinor: bigint };
  },
  options: ExportOptions,
): ReportTable => {
  const { labels, nameOf, asOfLine, shared, amountColumns } = base(options, data.currency);
  return {
    ...shared,
    title: labels.BALANCE_SHEET,
    period: asOfLine(data.asOf),
    columns: amountColumns,
    rows: [
      ...sectionRows(labels.assets, data.assets, labels.total, nameOf),
      ...sectionRows(labels.liabilities, data.liabilities, labels.total, nameOf),
      { kind: "section", cells: [labels.equity, null, null] },
      ...data.equity.items.map((line): ReportRow => ({ kind: "item", cells: [line.code, nameOf(line), line.amountMinor] })),
      { kind: "item", cells: [null, labels.unclosedProfit, data.equity.unclosedProfitMinor] },
      { kind: "total", cells: [null, labels.total, data.equity.totalMinor] },
      { kind: "total", cells: [null, labels.liabilitiesAndEquity, data.liabilities.totalMinor + data.equity.totalMinor] },
    ],
  };
};

export const cashFlowTable = (
  data: {
    from: string;
    to: string;
    currency: string;
    beginningCashMinor: bigint;
    openingBalancesMinor: bigint;
    operating: Section;
    investing: Section;
    financing: Section;
    netChangeMinor: bigint;
    endingCashMinor: bigint;
  },
  options: ExportOptions,
): ReportTable => {
  const { labels, nameOf, rangeLine, shared, amountColumns } = base(options, data.currency);
  return {
    ...shared,
    title: labels.CASH_FLOW,
    period: rangeLine(data.from, data.to),
    columns: amountColumns,
    rows: [
      { kind: "item", cells: [null, labels.beginningCash, data.beginningCashMinor] },
      { kind: "item", cells: [null, labels.openingBalances, data.openingBalancesMinor] },
      ...sectionRows(labels.operating, data.operating, labels.total, nameOf),
      ...sectionRows(labels.investing, data.investing, labels.total, nameOf),
      ...sectionRows(labels.financing, data.financing, labels.total, nameOf),
      { kind: "total", cells: [null, labels.netChange, data.netChangeMinor] },
      { kind: "total", cells: [null, labels.endingCash, data.endingCashMinor] },
    ],
  };
};
