import type { z } from "zod";
import type { transactionsValidation } from "./transactions.validation.js";

export type ITransactionParams = z.infer<typeof transactionsValidation.transactionParams>;
export type IAttachmentParams = z.infer<typeof transactionsValidation.attachmentParams>;
export type ICreateTransactionBody = z.infer<typeof transactionsValidation.create>;
export type IUpdateTransactionBody = z.infer<typeof transactionsValidation.update>;
export type IListTransactionsQuery = z.infer<typeof transactionsValidation.listQuery>;
export type ISetContactBody = z.infer<typeof transactionsValidation.setContact>;
export type IAttachBody = z.infer<typeof transactionsValidation.attach>;
export type IReverseTransactionBody = z.infer<typeof transactionsValidation.reverse>;

// The fields the business rules look at, after merging an update onto the stored draft.
export interface ITransactionDraft {
  type: ICreateTransactionBody["type"];
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  contactId: string | null;
  amountMinor: bigint;
  feeMinor: bigint;
  txnDate: Date;
  referenceNo: string | null;
}
