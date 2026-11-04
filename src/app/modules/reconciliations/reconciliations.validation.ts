import { z } from "zod";
import { dateField } from "../../utils/dates.js";
import { signedMinorAmountField } from "../../utils/money.js";

const reconciliationParams = z.object({ reconciliationId: z.uuid() });
const lineParams = reconciliationParams.extend({ journalLineId: z.uuid() });

const create = z.object({
  financialAccountId: z.uuid(),
  statementDate: dateField,
  statementBalanceMinor: signedMinorAmountField,
});

const matchLines = z.object({ journalLineIds: z.array(z.uuid()).min(1).max(500) });

// adjust: book any remaining difference to 6900 Reconciliation Adjustments, instead of refusing.
const close = z.object({ adjust: z.boolean().default(false) });

const listQuery = z.object({ financialAccountId: z.uuid().optional() });

export const reconciliationsValidation = { reconciliationParams, lineParams, create, matchLines, close, listQuery };
