import type { z } from "zod";
import type { businessesValidation } from "./businesses.validation.js";

export type ICreateBusinessBody = z.infer<typeof businessesValidation.create>;
export type IUpdateBusinessBody = z.infer<typeof businessesValidation.update>;
export type IChangeStatusBody = z.infer<typeof businessesValidation.changeStatus>;
export type IListBusinessesQuery = z.infer<typeof businessesValidation.listQuery>;
