import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { emailField, textField } from "../../utils/validationFields.js";

const contactKind = z.enum(["CUSTOMER", "SUPPLIER", "BOTH"]);

const contactParams = z.object({ contactId: z.uuid() });

const fields = {
  kind: contactKind,
  name: textField(120),
  company: textField(120).nullable(),
  phone: textField(30).nullable(),
  email: emailField.nullable(),
  address: textField(300).nullable(),
  taxId: textField(30).nullable(),
  notes: textField(1000).nullable(),
};

const create = z.object({
  kind: fields.kind,
  name: fields.name,
  company: fields.company.optional(),
  phone: fields.phone.optional(),
  email: fields.email.optional(),
  address: fields.address.optional(),
  taxId: fields.taxId.optional(),
  notes: fields.notes.optional(),
});

// Archive with isActive: false. Nothing is deleted, so old transactions keep their contact.
const update = z
  .object({ ...fields, isActive: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

// `kind` CUSTOMER also returns BOTH, and SUPPLIER likewise, so a picker shows everyone who fits.
const listQuery = z.object({
  ...paginationQuery,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  kind: z.enum(["CUSTOMER", "SUPPLIER"]).optional(),
  search: z.string().trim().max(100).optional(),
  includeArchived: z.stringbool().default(false),
});

export const contactsValidation = { contactParams, create, update, listQuery };
