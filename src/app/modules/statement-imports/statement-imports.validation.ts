import { z } from "zod";
import { statementMapping } from "../../integrations/statementFile.js";
import { paginationQuery } from "../../utils/pagination.js";

const importParams = z.object({ importId: z.uuid() });

const preview = z
  .object({
    documentId: z.uuid(),
    financialAccountId: z.uuid(),
    // Leave both out to see the file's columns and a suggested mapping.
    templateId: z.uuid().optional(),
    mapping: statementMapping.optional(),
  })
  .refine((body) => !(body.templateId && body.mapping), { message: "TEMPLATE_OR_MAPPING" });

const create = z
  .object({
    documentId: z.uuid(),
    financialAccountId: z.uuid(),
    templateId: z.uuid().optional(),
    mapping: statementMapping.optional(),
  })
  .refine((body) => Boolean(body.templateId) !== Boolean(body.mapping), { message: "TEMPLATE_OR_MAPPING" });

const listQuery = z.object({ ...paginationQuery, financialAccountId: z.uuid().optional() });

export const statementImportsValidation = { importParams, preview, create, listQuery };
