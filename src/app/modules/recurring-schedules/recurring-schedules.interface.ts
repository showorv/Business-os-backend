import type { z } from "zod";
import type { recurringSchedulesValidation } from "./recurring-schedules.validation.js";

export type IScheduleParams = z.infer<typeof recurringSchedulesValidation.scheduleParams>;
export type ICreateScheduleBody = z.infer<typeof recurringSchedulesValidation.create>;
export type IUpdateScheduleBody = z.infer<typeof recurringSchedulesValidation.update>;
export type IListSchedulesQuery = z.infer<typeof recurringSchedulesValidation.listQuery>;
