import { z } from "zod";
import { textField } from "../../utils/validationFields.js";

const ledgerType = z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);
const cashFlowClass = z.enum(["OPERATING", "INVESTING", "FINANCING"]);

const ledgerAccountParams = z.object({ ledgerAccountId: z.uuid() });

const create = z.object({
  code: z.string().regex(/^\d{4,6}$/),
  name: textField(120),
  nameBn: textField(120).optional(),
  type: ledgerType,
  cashFlowClass: cashFlowClass.optional(),
  parentId: z.uuid().optional(),
});

// Code and type are left out: posted journals depend on what the account means.
const update = z
  .object({
    name: textField(120),
    nameBn: textField(120).nullable(),
    cashFlowClass,
    parentId: z.uuid().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const listQuery = z.object({
  type: ledgerType.optional(),
  includeInactive: z.stringbool().default(false),
});

export const ledgerAccountsValidation = { ledgerAccountParams, create, update, listQuery };
