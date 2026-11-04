import { z } from "zod";

const periodParams = z.object({ periodId: z.uuid() });
const yearParams = z.object({ fiscalYear: z.coerce.number().int().min(2000).max(2100) });

const createYear = z.object({ fiscalYear: z.number().int().min(2000).max(2100) });
const changeStatus = z.object({ status: z.enum(["OPEN", "SOFT_CLOSED", "CLOSED"]) });
const listQuery = z.object({ fiscalYear: z.coerce.number().int().min(2000).max(2100).optional() });

export const fiscalPeriodsValidation = { periodParams, yearParams, createYear, changeStatus, listQuery };
