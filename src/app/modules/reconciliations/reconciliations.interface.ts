import type { z } from "zod";
import type { reconciliationsValidation } from "./reconciliations.validation.js";

export type IReconciliationParams = z.infer<typeof reconciliationsValidation.reconciliationParams>;
export type IReconciliationLineParams = z.infer<typeof reconciliationsValidation.lineParams>;
export type ICreateReconciliationBody = z.infer<typeof reconciliationsValidation.create>;
export type IMatchLinesBody = z.infer<typeof reconciliationsValidation.matchLines>;
export type ICloseReconciliationBody = z.infer<typeof reconciliationsValidation.close>;
export type IListReconciliationsQuery = z.infer<typeof reconciliationsValidation.listQuery>;
