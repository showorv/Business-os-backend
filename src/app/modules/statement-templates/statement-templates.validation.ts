import { z } from "zod";
import { statementMapping } from "../../integrations/statementFile.js";
import { textField } from "../../utils/validationFields.js";

const templateParams = z.object({ templateId: z.uuid() });
const create = z.object({ name: textField(120), mapping: statementMapping });
const update = z
  .object({ name: textField(120), mapping: statementMapping })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

export const statementTemplatesValidation = { templateParams, create, update };
