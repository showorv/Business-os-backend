import { z } from "zod";
import { itemsValidation } from "../modules/items/items.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const itemParams = businessParams.extend(itemsValidation.itemParams.shape);
const items = "/businesses/{businessId}/items";

const categoryRef = z.object({ id: z.uuid(), name: z.string(), nameBn: z.string().nullable() }).nullable();

// Issued (not voided) invoices or bills only. Quantity is a decimal string; amounts are minor units before VAT.
const movement = z.object({ quantity: z.string(), amountMinor: z.string(), lines: z.number().int() });

export const item = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string().nullable(),
  unit: z.string().nullable(),
  description: z.string().nullable(),
  salePriceMinor: z.string().nullable(),
  purchasePriceMinor: z.string().nullable(),
  vatRateBp: z.number().int(),
  incomeCategoryId: z.uuid().nullable(),
  expenseCategoryId: z.uuid().nullable(),
  incomeCategory: categoryRef,
  expenseCategory: categoryRef,
  isActive: z.boolean(),
  createdAt: z.string(),
  totals: z.object({ sold: movement, bought: movement }),
});

const T = "Items";
addPath(T, {
  method: "post",
  path: items,
  summary: "Save something the business sells or buys, with its usual prices, VAT rate and categories. Names are unique per business. No stock is counted. Needs finance.write",
  params: businessParams,
  body: itemsValidation.create,
  response: item,
  status: 201,
});
addPath(T, {
  method: "get",
  path: items,
  summary: "Items by name, with how much was sold and bought on issued invoices and bills. use=SALE lists those with a selling price, BILL those with a buying price. Needs finance.read",
  params: businessParams,
  query: itemsValidation.listQuery,
  response: z.array(item),
});
addPath(T, { method: "get", path: `${items}/{itemId}`, summary: "One item, with how much was sold and bought. Needs finance.read", params: itemParams, response: item });
addPath(T, { method: "patch", path: `${items}/{itemId}`, summary: "Change an item, or archive it with isActive: false. Lines already made keep their own prices. Needs finance.write", params: itemParams, body: itemsValidation.update, response: item });
