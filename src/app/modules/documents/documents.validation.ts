import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { textField } from "../../utils/validationFields.js";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

// Each of these can be confirmed from the file's own bytes when the upload completes.
export const ALLOWED_DOCUMENT_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;

export const CSV_MIME = "text/csv";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;

const documentType = z.enum(["INVOICE", "RECEIPT", "CONTRACT", "POLICY", "NOTE", "STATEMENT"]);

const documentParams = z.object({ documentId: z.uuid() });

// A statement is the only document that may be a spreadsheet, and it must be one.
const isStatementFile = (mime: string) => mime === CSV_MIME || mime === XLSX_MIME;

const createUpload = z
  .object({
    type: documentType,
    fileName: textField(255),
    mime: z.enum([...ALLOWED_DOCUMENT_TYPES, CSV_MIME, XLSX_MIME]),
    sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  })
  .refine((body) => isStatementFile(body.mime) === (body.type === "STATEMENT"), { message: "MIME_NOT_ALLOWED_FOR_TYPE" })
  .refine((body) => body.type !== "STATEMENT" || body.sizeBytes <= MAX_STATEMENT_BYTES, { message: "STATEMENT_FILE_TOO_LARGE" });

const listQuery = z.object({ ...paginationQuery, type: documentType.optional() });

export const documentsValidation = { documentParams, createUpload, listQuery };
