import type { Category, Prisma } from "../../generated/prisma/client.js";

type Template = Pick<Prisma.CategoryCreateManyInput, "type" | "name"> & { nameBn: string; type: Category["type"] };

const income = (name: string, nameBn: string): Template => ({ type: "INCOME", name, nameBn });
const expense = (name: string, nameBn: string): Template => ({ type: "EXPENSE", name, nameBn });

const COMMON: Template[] = [
  income("Other Income", "অন্যান্য আয়"),
  expense("Salaries", "বেতন"),
  expense("Rent", "ভাড়া"),
  expense("Utilities", "ইউটিলিটি"),
  expense("Marketing", "বিপণন"),
  expense("Bank & MFS Charges", "ব্যাংক ও এমএফএস চার্জ"),
  expense("Office Supplies", "অফিস সরঞ্জাম"),
  expense("Transport", "পরিবহন"),
  expense("Software & Subscriptions", "সফটওয়্যার ও সাবস্ক্রিপশন"),
  expense("Other Expenses", "অন্যান্য খরচ"),
];

const SALES = income("Sales", "বিক্রয়");
const SERVICES = income("Service Income", "সেবা আয়");
const PURCHASES = expense("Purchases", "ক্রয়");
const DELIVERY = expense("Delivery", "ডেলিভারি");

// The business type only picks this starting list. After that, each business owns and edits its own copy.
const BY_BUSINESS_TYPE: Record<string, Template[]> = {
  RETAIL: [SALES, PURCHASES],
  SERVICES: [SERVICES],
  AGENCY: [SERVICES, expense("Contractors", "চুক্তিভিত্তিক কর্মী")],
  ECOMMERCE: [SALES, PURCHASES, DELIVERY, expense("Payment Gateway Fees", "পেমেন্ট গেটওয়ে ফি")],
  MANUFACTURING: [SALES, expense("Raw Materials", "কাঁচামাল"), expense("Factory Costs", "কারখানার খরচ")],
  CUSTOM: [SALES],
};

export const categoryTemplatesFor = (businessType: string) => [...(BY_BUSINESS_TYPE[businessType] ?? []), ...COMMON];
