import { z } from "zod";
import { dateField } from "../../utils/dates.js";
import { paginationQuery } from "../../utils/pagination.js";
import { textField } from "../../utils/validationFields.js";

const priority = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const status = z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]);

const taskParams = z.object({ taskId: z.uuid() });
const attachmentParams = taskParams.extend({ documentId: z.uuid() });

const create = z.object({
  title: textField(200),
  description: textField(5000).optional(),
  assigneeId: z.uuid().optional(),
  priority: priority.default("MEDIUM"),
  dueAt: z.iso.datetime({ offset: true }).optional(),
});

const update = z
  .object({
    title: textField(200),
    description: textField(5000).nullable(),
    assigneeId: z.uuid().nullable(),
    priority,
    status,
    dueAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

// The filters behind the views: my tasks, overdue, and a date range.
const filters = {
  status: status.optional(),
  priority: priority.optional(),
  mine: z.stringbool().default(false),
  overdue: z.stringbool().default(false),
  dueFrom: z.iso.datetime({ offset: true }).optional(),
  dueTo: z.iso.datetime({ offset: true }).optional(),
};

const listQuery = z.object({ ...paginationQuery, ...filters, assigneeId: z.uuid().optional() });

const allBusinessesQuery = z.object({ ...paginationQuery, ...filters });

const calendarQuery = z.object({ from: dateField, to: dateField });

const comment = z.object({ body: textField(5000) });
const attach = z.object({ documentId: z.uuid() });

export const tasksValidation = {
  taskParams,
  attachmentParams,
  create,
  update,
  listQuery,
  allBusinessesQuery,
  calendarQuery,
  comment,
  attach,
};
