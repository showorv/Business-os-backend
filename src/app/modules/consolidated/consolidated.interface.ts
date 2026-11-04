import type { z } from "zod";
import type { consolidatedValidation } from "./consolidated.validation.js";

export type IConsolidatedQuery = z.infer<typeof consolidatedValidation.dashboardQuery>;
export type ICreateTransferBody = z.infer<typeof consolidatedValidation.createTransfer>;
