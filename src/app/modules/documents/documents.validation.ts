import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { textField } from "../../utils/validationFields.js";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

// Each of these can be confirmed from the file's own bytes when the upload completes.
export const ALLOWED_DOCUMENT_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;

const documentType = z.enum(["INVOICE", "RECEIPT", "CONTRACT", "POLICY", "NOTE"]);

const documentParams = z.object({ documentId: z.uuid() });

const createUpload = z.object({
  type: documentType,
  fileName: textField(255),
  mime: z.enum(ALLOWED_DOCUMENT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
});

const listQuery = z.object({ ...paginationQuery, type: documentType.optional() });

export const documentsValidation = { documentParams, createUpload, listQuery };
