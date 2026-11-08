import type { z } from "zod";
import type { itemsValidation } from "./items.validation.js";

export type IItemParams = z.infer<typeof itemsValidation.itemParams>;
export type ICreateItemBody = z.infer<typeof itemsValidation.create>;
export type IUpdateItemBody = z.infer<typeof itemsValidation.update>;
export type IListItemsQuery = z.infer<typeof itemsValidation.listQuery>;

// How much of an item went out on issued invoices, or came in on issued bills. Voided ones and
// drafts don't count. Quantity is a decimal string, the amount is in minor units before VAT.
export interface IItemMovement {
  quantity: string;
  amountMinor: string;
  lines: number;
}

export interface IItemTotals {
  sold: IItemMovement;
  bought: IItemMovement;
}
