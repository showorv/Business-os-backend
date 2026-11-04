import type { z } from "zod";
import type { remindersValidation } from "./reminders.validation.js";

export type IReminderParams = z.infer<typeof remindersValidation.reminderParams>;
export type ICreateReminderBody = z.infer<typeof remindersValidation.create>;
export type IUpdateReminderBody = z.infer<typeof remindersValidation.update>;
export type IListRemindersQuery = z.infer<typeof remindersValidation.listQuery>;

// What a task or schedule says about its automatic reminder.
export interface ISourceReminder {
  sourceType: "TASK" | "RECURRING_SCHEDULE";
  sourceId: string;
  title: string;
  startsAt: Date | null;
  rrule: string | null;
  timezone?: string;
  leadMinutes: number;
  recipientUserId: string;
  active: boolean;
}
