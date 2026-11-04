import type { z } from "zod";
import type { reportExportsValidation } from "./report-exports.validation.js";

export type IExportParams = z.infer<typeof reportExportsValidation.exportParams>;
export type ICreateExportBody = z.infer<typeof reportExportsValidation.create>;
export type IListExportsQuery = z.infer<typeof reportExportsValidation.listQuery>;

export interface ExportParams {
  asOf?: string;
  from?: string;
  to?: string;
}
