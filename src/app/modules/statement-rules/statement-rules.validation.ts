import { z } from "zod";
import { positiveMinorAmountField } from "../../utils/money.js";
import { textField } from "../../utils/validationFields.js";

const ruleParams = z.object({ ruleId: z.uuid() });

const create = z.object({
  name: textField(120),
  // Plain text, not a pattern. "facebook" also finds "FACEBOOK ADS".
  containsText: textField(200),
  direction: z.enum(["IN", "OUT"]),
  categoryId: z.uuid(),
  maxAmountMinor: positiveMinorAmountField.optional(),
  autoPost: z.boolean().default(false),
  // Lower runs first. The first rule that fits wins.
  priority: z.number().int().min(0).max(10_000).default(100),
});

const update = z
  .object({
    name: textField(120),
    containsText: textField(200),
    categoryId: z.uuid(),
    maxAmountMinor: positiveMinorAmountField.nullable(),
    autoPost: z.boolean(),
    priority: z.number().int().min(0).max(10_000),
    isActive: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

export const statementRulesValidation = { ruleParams, create, update };
