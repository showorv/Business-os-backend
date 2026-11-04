import type { z } from "zod";
import type { accountsValidation } from "./accounts.validation.js";

export type IAccountParams = z.infer<typeof accountsValidation.accountParams>;
export type ICreateAccountBody = z.infer<typeof accountsValidation.create>;
export type IUpdateAccountBody = z.infer<typeof accountsValidation.update>;
export type IListAccountsQuery = z.infer<typeof accountsValidation.listQuery>;

export interface ICashAccountInput {
  workspaceId: string;
  businessId: string;
  createdBy: string;
  currency: string;
  openingDate: Date;
}
