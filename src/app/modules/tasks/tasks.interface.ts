import type { z } from "zod";
import type { tasksValidation } from "./tasks.validation.js";

export type ITaskParams = z.infer<typeof tasksValidation.taskParams>;
export type IAttachmentParams = z.infer<typeof tasksValidation.attachmentParams>;
export type ICreateTaskBody = z.infer<typeof tasksValidation.create>;
export type IUpdateTaskBody = z.infer<typeof tasksValidation.update>;
export type IListTasksQuery = z.infer<typeof tasksValidation.listQuery>;
export type IAllBusinessesTasksQuery = z.infer<typeof tasksValidation.allBusinessesQuery>;
export type ICalendarQuery = z.infer<typeof tasksValidation.calendarQuery>;
export type ICommentBody = z.infer<typeof tasksValidation.comment>;
export type IAttachBody = z.infer<typeof tasksValidation.attach>;
