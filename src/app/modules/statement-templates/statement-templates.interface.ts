import type { z } from "zod";
import type { statementTemplatesValidation } from "./statement-templates.validation.js";

export type ITemplateParams = z.infer<typeof statementTemplatesValidation.templateParams>;
export type ICreateTemplateBody = z.infer<typeof statementTemplatesValidation.create>;
export type IUpdateTemplateBody = z.infer<typeof statementTemplatesValidation.update>;
