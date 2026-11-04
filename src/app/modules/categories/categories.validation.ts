import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { textField } from "../../utils/validationFields.js";

const categoryType = z.enum(["INCOME", "EXPENSE"]);

const categoryParams = z.object({ categoryId: z.uuid() });

const create = z.object({ type: categoryType, name: textField(120), nameBn: textField(120).optional() });

// `type` is left out: past transactions depend on it.
const update = z
  .object({ name: textField(120), nameBn: textField(120).nullable(), isActive: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const listQuery = z.object({
  ...paginationQuery,
  limit: z.coerce.number().int().min(1).max(200).default(100),
  type: categoryType.optional(),
  includeInactive: z.stringbool().default(false),
});

export const categoriesValidation = { categoryParams, create, update, listQuery };
