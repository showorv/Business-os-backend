import type { z } from "zod";
import type { ledgerAccountsValidation } from "./ledger-accounts.validation.js";

export type ILedgerAccountParams = z.infer<typeof ledgerAccountsValidation.ledgerAccountParams>;
export type ICreateLedgerAccountBody = z.infer<typeof ledgerAccountsValidation.create>;
export type IUpdateLedgerAccountBody = z.infer<typeof ledgerAccountsValidation.update>;
export type IListLedgerAccountsQuery = z.infer<typeof ledgerAccountsValidation.listQuery>;

// Who a change to the books is made for. A BusinessContext fits this shape.
export interface LedgerActor {
  userId: string;
  workspaceId: string;
  businessId: string;
  baseCurrency: string;
}
