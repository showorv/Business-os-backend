import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { reminderRuleField } from "../../utils/rrule.js";
import { textField, timezoneField } from "../../utils/validationFields.js";

const channels = z.array(z.enum(["IN_APP", "EMAIL", "PUSH"])).min(1).transform((values) => [...new Set(values)]);
const MAX_LEAD_MINUTES = 60 * 24 * 365;

const reminderParams = z.object({ reminderId: z.uuid() });

const create = z.object({
  title: textField(200),
  // The first occurrence. With a rule, it also sets the time of day of the ones after it.
  startsAt: z.iso.datetime({ offset: true }),
  rrule: reminderRuleField.optional(),
  // Defaults to the business's timezone.
  timezone: timezoneField.optional(),
  leadMinutes: z.number().int().min(0).max(MAX_LEAD_MINUTES).default(0),
  channels: channels.default(["IN_APP", "EMAIL", "PUSH"]),
  // Defaults to the person creating it.
  recipientUserId: z.uuid().optional(),
});

const update = z
  .object({
    title: textField(200),
    startsAt: z.iso.datetime({ offset: true }),
    rrule: reminderRuleField.nullable(),
    timezone: timezoneField,
    leadMinutes: z.number().int().min(0).max(MAX_LEAD_MINUTES),
    channels,
    recipientUserId: z.uuid(),
    status: z.enum(["ACTIVE", "PAUSED", "CANCELLED"]),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const listQuery = z.object({
  ...paginationQuery,
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]).optional(),
  sourceType: z.enum(["MANUAL", "TASK", "RECURRING_SCHEDULE"]).optional(),
  mine: z.stringbool().default(false),
});

export const remindersValidation = { reminderParams, create, update, listQuery };
