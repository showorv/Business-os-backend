import type { z } from "zod";
import type { documentsValidation } from "./documents.validation.js";

export type IDocumentParams = z.infer<typeof documentsValidation.documentParams>;
export type ICreateUploadBody = z.infer<typeof documentsValidation.createUpload>;
export type IListDocumentsQuery = z.infer<typeof documentsValidation.listQuery>;

export type UploadProblem = "NOT_UPLOADED" | "SIZE_MISMATCH" | "TYPE_MISMATCH";
