// The starting chart of accounts (architecture document, section 4.2). A business owns its copy.
type LedgerType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
type CashFlowClass = "OPERATING" | "INVESTING" | "FINANCING";

export interface ChartTemplate {
  code: string;
  name: string;
  nameBn: string;
  type: LedgerType;
  normalBalance: "DEBIT" | "CREDIT";
  cashFlowClass: CashFlowClass;
}

// Accounts the code itself posts to.
export const LedgerCode = {
  SALARIES: "6000",
  CASH: "1100",
  ACCOUNTS_RECEIVABLE: "1200",
  // VAT paid on purchases that can be set against VAT collected (VAT-registered businesses only).
  VAT_INPUT: "1400",
  DUE_FROM_BUSINESSES: "1300",
  ACCOUNTS_PAYABLE: "2000",
  // VAT collected on sales, owed to NBR until paid.
  VAT_PAYABLE: "2200",
  DUE_TO_BUSINESSES: "2300",
  OWNERS_EQUITY: "3000",
  OWNERS_DRAWINGS: "3100",
  RETAINED_EARNINGS: "3200",
  OPENING_BALANCE_EQUITY: "3900",
  SALES_RETURNS: "4900",
  BANK_CHARGES: "6500",
  RECONCILIATION_ADJUSTMENT: "6900",
} as const;

// Assets and expenses normally carry a debit balance; everything else a credit balance.
export const normalBalanceOf = (type: LedgerType) => (type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT");

const account = (
  code: string,
  name: string,
  nameBn: string,
  type: LedgerType,
  options: { normalBalance?: "DEBIT" | "CREDIT"; cashFlowClass?: CashFlowClass } = {},
): ChartTemplate => ({
  code,
  name,
  nameBn,
  type,
  normalBalance: options.normalBalance ?? normalBalanceOf(type),
  cashFlowClass: options.cashFlowClass ?? "OPERATING",
});

const COMMON: ChartTemplate[] = [
  account("1100", "Cash", "নগদ", "ASSET"),
  account("1200", "Accounts Receivable", "প্রাপ্য হিসাব", "ASSET"),
  account("1300", "Due From Other Businesses", "অন্য ব্যবসা থেকে প্রাপ্য", "ASSET"),
  account("1400", "VAT Input (Recoverable)", "উপকরণ ভ্যাট (ফেরতযোগ্য)", "ASSET"),
  account("1500", "Fixed Assets", "স্থায়ী সম্পদ", "ASSET", { cashFlowClass: "INVESTING" }),
  account("2000", "Accounts Payable", "প্রদেয় হিসাব", "LIABILITY"),
  account("2100", "Payroll Liabilities", "বেতন সংক্রান্ত দায়", "LIABILITY"),
  account("2200", "VAT Payable", "প্রদেয় ভ্যাট", "LIABILITY"),
  account("2300", "Due To Other Businesses", "অন্য ব্যবসাকে প্রদেয়", "LIABILITY"),
  account("2500", "Loans Payable", "প্রদেয় ঋণ", "LIABILITY", { cashFlowClass: "FINANCING" }),
  account("3000", "Owner's Equity", "মালিকের মূলধন", "EQUITY", { cashFlowClass: "FINANCING" }),
  account("3100", "Owner's Drawings", "মালিকের উত্তোলন", "EQUITY", { normalBalance: "DEBIT", cashFlowClass: "FINANCING" }),
  account("3200", "Retained Earnings", "সংরক্ষিত আয়", "EQUITY", { cashFlowClass: "FINANCING" }),
  account("3900", "Opening Balance Equity", "প্রারম্ভিক ব্যালেন্স ইকুইটি", "EQUITY", { cashFlowClass: "FINANCING" }),
  account("4800", "Other Income", "অন্যান্য আয়", "REVENUE"),
  // A contra-revenue account: it sits under revenue, but reduces it.
  account("4900", "Sales Returns", "বিক্রয় ফেরত", "REVENUE", { normalBalance: "DEBIT" }),
  account("6000", "Salaries Expense", "বেতন খরচ", "EXPENSE"),
  account("6100", "Rent Expense", "ভাড়া খরচ", "EXPENSE"),
  account("6200", "Utilities Expense", "ইউটিলিটি খরচ", "EXPENSE"),
  account("6300", "Marketing Expense", "বিপণন খরচ", "EXPENSE"),
  account("6400", "Office Supplies", "অফিস সরঞ্জাম", "EXPENSE"),
  account("6450", "Transport Expense", "পরিবহন খরচ", "EXPENSE"),
  account("6500", "Bank & MFS Charges", "ব্যাংক ও এমএফএস চার্জ", "EXPENSE"),
  account("6600", "Software & Subscriptions", "সফটওয়্যার ও সাবস্ক্রিপশন", "EXPENSE"),
  account("6800", "Other Expenses", "অন্যান্য খরচ", "EXPENSE"),
  account("6900", "Reconciliation Adjustments", "সমন্বয় হিসাব", "EXPENSE"),
];

const SALES = account("4000", "Sales Revenue", "বিক্রয় আয়", "REVENUE");
const SERVICES = account("4100", "Service Revenue", "সেবা আয়", "REVENUE");
const PURCHASES = account("5000", "Purchases", "ক্রয়", "EXPENSE");
const DELIVERY = account("5100", "Delivery Costs", "ডেলিভারি খরচ", "EXPENSE");

// The business type only adds to the starting list.
const BY_BUSINESS_TYPE: Record<string, ChartTemplate[]> = {
  RETAIL: [SALES, PURCHASES],
  SERVICES: [SERVICES],
  AGENCY: [SERVICES, account("6700", "Contractors", "চুক্তিভিত্তিক কর্মী", "EXPENSE")],
  ECOMMERCE: [SALES, PURCHASES, DELIVERY, account("5400", "Payment Gateway Fees", "পেমেন্ট গেটওয়ে ফি", "EXPENSE")],
  MANUFACTURING: [
    SALES,
    account("5200", "Raw Materials", "কাঁচামাল", "EXPENSE"),
    account("5300", "Factory Costs", "কারখানার খরচ", "EXPENSE"),
  ],
  CUSTOM: [SALES],
};

// One of the accounts every business has, by code. For accounts added after a business was created.
export const commonTemplate = (code: string) => COMMON.find((template) => template.code === code);

export const chartTemplateFor = (businessType: string) => [...COMMON, ...(BY_BUSINESS_TYPE[businessType] ?? [])];

// Where new accounts get their next free code.
export const CODE_RANGES = {
  CASH: [1101, 1109],
  BANK: [1110, 1129],
  BKASH: [1130, 1139],
  NAGAD: [1140, 1149],
  MFS_OTHER: [1150, 1159],
  CUSTOM: [1160, 1199],
  INCOME_CATEGORY: [4500, 4799],
  EXPENSE_CATEGORY: [7000, 7999],
} as const;
