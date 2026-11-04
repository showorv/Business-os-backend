import type { z } from "zod";
import type { statementImportsValidation } from "./statement-imports.validation.js";

export type IImportParams = z.infer<typeof statementImportsValidation.importParams>;
export type IPreviewBody = z.infer<typeof statementImportsValidation.preview>;
export type ICreateImportBody = z.infer<typeof statementImportsValidation.create>;
export type IListImportsQuery = z.infer<typeof statementImportsValidation.listQuery>;
