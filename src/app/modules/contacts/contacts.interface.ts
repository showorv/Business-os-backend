import type { z } from "zod";
import type { contactsValidation } from "./contacts.validation.js";

export type IContactParams = z.infer<typeof contactsValidation.contactParams>;
export type ICreateContactBody = z.infer<typeof contactsValidation.create>;
export type IUpdateContactBody = z.infer<typeof contactsValidation.update>;
export type IListContactsQuery = z.infer<typeof contactsValidation.listQuery>;

// Posted money with one contact, in one currency. Amounts are in minor units, as strings.
export interface IContactTotals {
  currency: string;
  // Income from them.
  receivedMinor: string;
  // Expenses paid to them, and refunds given back to them.
  paidMinor: string;
  transactions: number;
  lastDate: string | null;
}
