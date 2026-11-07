import { z } from "zod";
import { contactsValidation } from "../modules/contacts/contacts.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const contactParams = businessParams.extend(contactsValidation.contactParams.shape);
const contacts = "/businesses/{businessId}/contacts";

// Posted money with the contact, one row per currency. Amounts are in minor units, as strings.
const totals = z.object({
  currency: z.string(),
  receivedMinor: z.string(),
  paidMinor: z.string(),
  transactions: z.number().int(),
  lastDate: z.string().nullable(),
});

export const contact = z.object({
  id: z.uuid(),
  kind: z.enum(["CUSTOMER", "SUPPLIER", "BOTH"]),
  name: z.string(),
  company: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  taxId: z.string().nullable(),
  notes: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  totals: z.array(totals),
});

const T = "Contacts";
addPath(T, { method: "post", path: contacts, summary: "Add a customer or supplier. Needs finance.write", params: businessParams, body: contactsValidation.create, response: contact, status: 201 });
addPath(T, {
  method: "get",
  path: contacts,
  summary: "Customers and suppliers by name, with what was received from and paid to each. kind=CUSTOMER also lists BOTH. Needs finance.read",
  params: businessParams,
  query: contactsValidation.listQuery,
  response: z.array(contact),
});
addPath(T, { method: "get", path: `${contacts}/{contactId}`, summary: "One contact, with totals. Its transactions: GET /transactions?contactId=. Needs finance.read", params: contactParams, response: contact });
addPath(T, { method: "patch", path: `${contacts}/{contactId}`, summary: "Change details, or archive with isActive: false. Needs finance.write", params: contactParams, body: contactsValidation.update, response: contact });
