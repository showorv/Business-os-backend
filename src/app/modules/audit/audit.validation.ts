import { z } from "zod";
import { normalizeDigits } from "../../utils/normalize.js";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Audit id of the last row on the previous page.
  cursor: z
    .string()
    .overwrite(normalizeDigits)
    .regex(/^\d{1,19}$/)
    .optional(),
});

export const auditValidation = { listQuery };
