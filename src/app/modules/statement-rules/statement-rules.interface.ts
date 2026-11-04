import type { z } from "zod";
import type { statementRulesValidation } from "./statement-rules.validation.js";

export type IRuleParams = z.infer<typeof statementRulesValidation.ruleParams>;
export type ICreateRuleBody = z.infer<typeof statementRulesValidation.create>;
export type IUpdateRuleBody = z.infer<typeof statementRulesValidation.update>;
