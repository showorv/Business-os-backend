export interface CategoryTemplate {
  type: "INCOME" | "EXPENSE";
  name: string;
  nameBn: string;
  // The account in chartOfAccounts.ts that this category posts to.
  ledgerCode: string;
}

const income = (name: string, nameBn: string, ledgerCode: string): CategoryTemplate => ({ type: "INCOME", name, nameBn, ledgerCode });
const expense = (name: string, nameBn: string, ledgerCode: string): CategoryTemplate => ({ type: "EXPENSE", name, nameBn, ledgerCode });

const COMMON: CategoryTemplate[] = [
  income("Other Income", "অন্যান্য আয়", "4800"),
  expense("Salaries", "বেতন", "6000"),
  expense("Rent", "ভাড়া", "6100"),
  expense("Utilities", "ইউটিলিটি", "6200"),
  expense("Marketing", "বিপণন", "6300"),
  expense("Bank & MFS Charges", "ব্যাংক ও এমএফএস চার্জ", "6500"),
  expense("Office Supplies", "অফিস সরঞ্জাম", "6400"),
  expense("Transport", "পরিবহন", "6450"),
  expense("Software & Subscriptions", "সফটওয়্যার ও সাবস্ক্রিপশন", "6600"),
  expense("Other Expenses", "অন্যান্য খরচ", "6800"),
];

const SALES = income("Sales", "বিক্রয়", "4000");
const SERVICES = income("Service Income", "সেবা আয়", "4100");
const PURCHASES = expense("Purchases", "ক্রয়", "5000");
const DELIVERY = expense("Delivery", "ডেলিভারি", "5100");

// The business type only picks this starting list. After that, each business owns and edits its own copy.
const BY_BUSINESS_TYPE: Record<string, CategoryTemplate[]> = {
  RETAIL: [SALES, PURCHASES],
  SERVICES: [SERVICES],
  AGENCY: [SERVICES, expense("Contractors", "চুক্তিভিত্তিক কর্মী", "6700")],
  ECOMMERCE: [SALES, PURCHASES, DELIVERY, expense("Payment Gateway Fees", "পেমেন্ট গেটওয়ে ফি", "5400")],
  MANUFACTURING: [SALES, expense("Raw Materials", "কাঁচামাল", "5200"), expense("Factory Costs", "কারখানার খরচ", "5300")],
  CUSTOM: [SALES],
};

export const categoryTemplatesFor = (businessType: string) => [...(BY_BUSINESS_TYPE[businessType] ?? []), ...COMMON];
