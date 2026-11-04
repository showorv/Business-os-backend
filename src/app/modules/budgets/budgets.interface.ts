import type { z } from "zod";
import type { budgetsValidation } from "./budgets.validation.js";

export type IBudgetParams = z.infer<typeof budgetsValidation.budgetParams>;
export type IBudgetLineBody = z.infer<typeof budgetsValidation.line>;
export type ICreateBudgetBody = z.infer<typeof budgetsValidation.create>;
export type IUpdateBudgetBody = z.infer<typeof budgetsValidation.update>;
export type IListBudgetsQuery = z.infer<typeof budgetsValidation.listQuery>;
