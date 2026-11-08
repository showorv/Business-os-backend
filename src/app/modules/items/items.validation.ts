import { z } from "zod";
import { minorAmountField } from "../../utils/money.js";
import { paginationQuery } from "../../utils/pagination.js";
import { textField } from "../../utils/validationFields.js";

const itemParams = z.object({ itemId: z.uuid() });

const fields = {
  name: textField(120),
  code: textField(40).nullable(),
  unit: textField(20).nullable(),
  description: textField(300).nullable(),
  // Before VAT, in minor units. Empty when the business doesn't sell (or doesn't buy) it.
  salePriceMinor: minorAmountField.nullable(),
  purchasePriceMinor: minorAmountField.nullable(),
  // Basis points: 1500 is 15%.
  vatRateBp: z.number().int().min(0).max(10000),
  incomeCategoryId: z.uuid().nullable(),
  expenseCategoryId: z.uuid().nullable(),
};

const create = z.object({
  name: fields.name,
  code: fields.code.optional(),
  unit: fields.unit.optional(),
  description: fields.description.optional(),
  salePriceMinor: fields.salePriceMinor.optional(),
  purchasePriceMinor: fields.purchasePriceMinor.optional(),
  vatRateBp: fields.vatRateBp.default(0),
  incomeCategoryId: fields.incomeCategoryId.optional(),
  expenseCategoryId: fields.expenseCategoryId.optional(),
});

// Archive with isActive: false. Nothing is deleted, so old invoice lines keep their item.
const update = z
  .object({ ...fields, isActive: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

// `use` SALE lists items with a selling price, BILL those with a buying price, for the line pickers.
const listQuery = z.object({
  ...paginationQuery,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(100).optional(),
  use: z.enum(["SALE", "BILL"]).optional(),
  includeArchived: z.stringbool().default(false),
});

export const itemsValidation = { itemParams, create, update, listQuery };
