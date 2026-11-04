import { z } from "zod";
import { documentsValidation } from "../modules/documents/documents.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const documentParams = businessParams.extend(documentsValidation.documentParams.shape);

const document = z.object({
  id: z.uuid(),
  type: z.string(),
  status: z.enum(["PENDING_UPLOAD", "READY", "REJECTED"]),
  fileName: z.string(),
  mime: z.string(),
  sizeBytes: z.string(),
  sha256: z.string().nullable(),
  scanStatus: z.string(),
  ingestStatus: z.string(),
});

const documents = "/businesses/{businessId}/documents";

addPath("Documents", { method: "post", path: `${documents}/uploads`, summary: "Step 1: get a signed URL, then PUT the file to it with the same Content-Type. Needs documents.write", params: businessParams, body: documentsValidation.createUpload, status: 201, response: z.object({ document, uploadUrl: z.string(), expiresIn: z.number() }) });
addPath("Documents", { method: "post", path: `${documents}/{documentId}/complete`, summary: "Step 2: check the stored file and mark it READY. Needs documents.write", params: documentParams, response: document });
addPath("Documents", { method: "get", path: documents, summary: "List finished documents. Needs documents.read", params: businessParams, query: documentsValidation.listQuery, response: z.array(document) });
addPath("Documents", { method: "get", path: `${documents}/{documentId}/download`, summary: "Get a 5-minute download link. Needs documents.read", params: documentParams, response: z.object({ url: z.string(), expiresIn: z.number() }) });
addPath("Documents", { method: "delete", path: `${documents}/{documentId}`, summary: "Soft delete. Refused while attached to a transaction. Needs documents.write", params: documentParams });
