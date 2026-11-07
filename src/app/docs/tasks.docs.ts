import { z } from "zod";
import { notificationsValidation } from "../modules/notifications/notifications.validation.js";
import { recurringSchedulesValidation } from "../modules/recurring-schedules/recurring-schedules.validation.js";
import { remindersValidation } from "../modules/reminders/reminders.validation.js";
import { tasksValidation } from "../modules/tasks/tasks.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const taskParams = businessParams.extend(tasksValidation.taskParams.shape);
const attachmentParams = businessParams.extend(tasksValidation.attachmentParams.shape);
const reminderParams = businessParams.extend(remindersValidation.reminderParams.shape);
const scheduleParams = businessParams.extend(recurringSchedulesValidation.scheduleParams.shape);

const page = (item: z.ZodType) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

const task = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  assigneeId: z.uuid().nullable(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]),
  dueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  isOverdue: z.boolean(),
  createdBy: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const taskDetail = task.extend({ attachments: z.array(z.object({ documentId: z.uuid(), createdAt: z.string() })) });

const comment = z.object({ id: z.uuid(), authorId: z.uuid(), body: z.string(), createdAt: z.string() });

const reminder = z.object({
  id: z.uuid(),
  title: z.string(),
  rrule: z.string().nullable(),
  startsAt: z.string(),
  timezone: z.string(),
  leadMinutes: z.number(),
  nextOccurrenceAt: z.string().nullable(),
  nextFireAt: z.string().nullable(),
  lastFiredAt: z.string().nullable(),
  channels: z.array(z.enum(["IN_APP", "EMAIL", "PUSH"])),
  recipientUserId: z.uuid(),
  sourceType: z.enum(["MANUAL", "TASK", "RECURRING_SCHEDULE"]),
  sourceId: z.uuid().nullable(),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]),
  createdBy: z.uuid(),
  createdAt: z.string(),
});

const schedule = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(["TRANSACTION", "SALARY"]),
  rrule: z.string(),
  startDate: z.string(),
  timezone: z.string(),
  nextRunAt: z.string().nullable(),
  type: z.enum(["INCOME", "EXPENSE", "TRANSFER"]),
  accountId: z.uuid(),
  toAccountId: z.uuid().nullable(),
  categoryId: z.uuid().nullable(),
  amountMinor: z.string(),
  feeMinor: z.string(),
  description: z.string().nullable(),
  autoPost: z.boolean(),
  remindDaysBefore: z.number().nullable(),
  status: z.enum(["ACTIVE", "PAUSED", "ENDED"]),
  createdBy: z.uuid(),
  createdAt: z.string(),
});

const run = z.object({
  id: z.uuid(),
  occurrenceDate: z.string(),
  status: z.enum(["CREATED", "FAILED"]),
  transactionId: z.uuid().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
});

const notification = z.object({
  id: z.uuid(),
  type: z.string(),
  params: z.record(z.string(), z.unknown()),
  businessId: z.uuid().nullable(),
  entityType: z.string().nullable(),
  entityId: z.uuid().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

const delivery = z.object({
  channel: z.enum(["IN_APP", "EMAIL", "PUSH"]),
  status: z.enum(["PENDING", "QUEUED", "SENT", "FAILED", "SKIPPED"]),
  attempts: z.number(),
  lastErrorCode: z.string().nullable(),
  sendAfter: z.string(),
  sentAt: z.string().nullable(),
});

const preferences = z.object({
  emailEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  timezone: z.string(),
});

const calendarItem = z.object({
  kind: z.enum(["TASK", "REMINDER"]),
  id: z.uuid(),
  title: z.string(),
  at: z.string(),
  date: z.string(),
  userId: z.uuid().nullable(),
});

const tasks = "/businesses/{businessId}/tasks";
const reminders = "/businesses/{businessId}/reminders";
const schedules = "/businesses/{businessId}/recurring-schedules";
const notifications = "/notifications";

addPath("Tasks", { method: "post", path: tasks, summary: "Create a task. A due date adds a reminder automatically. Needs tasks.write", params: businessParams, body: tasksValidation.create, response: task, status: 201 });
addPath("Tasks", { method: "get", path: tasks, summary: "List tasks: all, mine=true or overdue=true. Needs tasks.read", params: businessParams, query: tasksValidation.listQuery, response: page(task) });
addPath("Tasks", { method: "get", path: `${tasks}/summary`, summary: "How many tasks are in each status, overdue, and assigned to you. Needs tasks.read", params: businessParams, response: z.object({ todo: z.number(), inProgress: z.number(), blocked: z.number(), done: z.number(), cancelled: z.number(), overdue: z.number(), assignedToMe: z.number() }) });
addPath("Tasks", { method: "get", path: `${tasks}/calendar`, summary: "Tasks and reminders by day, for up to 62 days. Needs tasks.read", params: businessParams, query: tasksValidation.calendarQuery, response: z.array(calendarItem) });
addPath("Tasks", { method: "get", path: `${tasks}/{taskId}`, summary: "One task with its attachments. Needs tasks.read", params: taskParams, response: taskDetail });
addPath("Tasks", { method: "patch", path: `${tasks}/{taskId}`, summary: "Change a task or move its status. Needs tasks.write", params: taskParams, body: tasksValidation.update, response: task });
addPath("Tasks", { method: "get", path: `${tasks}/{taskId}/comments`, summary: "A task's comments, oldest first. Needs tasks.read", params: taskParams, response: z.array(comment) });
addPath("Tasks", { method: "post", path: `${tasks}/{taskId}/comments`, summary: "Add a comment. Tells the assignee and creator. Needs tasks.write", params: taskParams, body: tasksValidation.comment, response: comment, status: 201 });
addPath("Tasks", { method: "post", path: `${tasks}/{taskId}/attachments`, summary: "Attach a finished document. Needs tasks.write", params: taskParams, body: tasksValidation.attach });
addPath("Tasks", { method: "delete", path: `${tasks}/{taskId}/attachments/{documentId}`, summary: "Remove an attachment. The document stays. Needs tasks.write", params: attachmentParams });
addPath("Tasks", { method: "get", path: "/tasks", summary: "Tasks across every business you can read. The server works out which ones", query: tasksValidation.allBusinessesQuery, response: page(task.extend({ businessName: z.string().nullable() })) });

addPath("Reminders", { method: "post", path: reminders, summary: "Create a one-time or repeating (RRULE) reminder. Needs tasks.write", params: businessParams, body: remindersValidation.create, response: reminder, status: 201 });
addPath("Reminders", { method: "get", path: reminders, summary: "List reminders. Needs tasks.read", params: businessParams, query: remindersValidation.listQuery, response: page(reminder) });
addPath("Reminders", { method: "get", path: `${reminders}/{reminderId}`, summary: "One reminder. Needs tasks.read", params: reminderParams, response: reminder });
addPath("Reminders", { method: "patch", path: `${reminders}/{reminderId}`, summary: "Change, pause or cancel a reminder you made. Needs tasks.write", params: reminderParams, body: remindersValidation.update, response: reminder });

addPath("Recurring schedules", { method: "post", path: schedules, summary: "Repeat a transaction or salary. Needs finance.write, and ledger.post for autoPost", params: businessParams, body: recurringSchedulesValidation.create, response: schedule, status: 201 });
addPath("Recurring schedules", { method: "get", path: schedules, summary: "List schedules. Needs finance.read", params: businessParams, query: recurringSchedulesValidation.listQuery, response: page(schedule) });
addPath("Recurring schedules", { method: "get", path: `${schedules}/{scheduleId}`, summary: "One schedule with its recent runs. Needs finance.read", params: scheduleParams, response: schedule.extend({ runs: z.array(run) }) });
addPath("Recurring schedules", { method: "patch", path: `${schedules}/{scheduleId}`, summary: "Change, pause, resume or end a schedule. Needs finance.write", params: scheduleParams, body: recurringSchedulesValidation.update, response: schedule });
addPath("Recurring schedules", { method: "post", path: `${schedules}/{scheduleId}/run`, summary: "Run whatever is due now, without waiting for the worker's timer. Needs finance.write", params: scheduleParams, response: schedule.extend({ runs: z.array(run) }) });

addPath("Notifications", { method: "get", path: notifications, summary: "Your in-app notifications. Each has a type and values for the app to word", query: notificationsValidation.listQuery, response: page(notification) });
addPath("Notifications", { method: "get", path: `${notifications}/unread-count`, summary: "How many you haven't read", response: z.object({ count: z.number() }) });
addPath("Notifications", { method: "get", path: `${notifications}/stream`, summary: "Live updates as Server-Sent Events. Ends when your access token does; reconnect with a new one" });
addPath("Notifications", { method: "post", path: `${notifications}/read-all`, summary: "Mark everything as read", response: z.object({ marked: z.number() }) });
addPath("Notifications", { method: "post", path: `${notifications}/{notificationId}/read`, summary: "Mark one as read", params: notificationsValidation.notificationParams, response: notification });
addPath("Notifications", { method: "get", path: `${notifications}/{notificationId}/deliveries`, summary: "What happened on each channel", params: notificationsValidation.notificationParams, response: z.array(delivery) });
addPath("Notifications", { method: "get", path: `${notifications}/preferences`, summary: "Your channel settings and quiet hours", response: preferences });
addPath("Notifications", { method: "patch", path: `${notifications}/preferences`, summary: "Change your channel settings and quiet hours", body: notificationsValidation.updatePreferences, response: preferences });
addPath("Notifications", { method: "get", path: `${notifications}/push/config`, summary: "Whether push is on, and the key a browser needs to subscribe", response: z.object({ enabled: z.boolean(), publicKey: z.string().nullable() }) });
addPath("Notifications", { method: "get", path: `${notifications}/push/subscriptions`, summary: "The browsers receiving your push notifications", response: z.array(z.object({ id: z.uuid(), userAgent: z.string().nullable(), createdAt: z.string() })) });
addPath("Notifications", { method: "post", path: `${notifications}/push/subscriptions`, summary: "Save this browser's push subscription", body: notificationsValidation.pushSubscribe, response: z.object({ id: z.uuid(), createdAt: z.string() }), status: 201 });
addPath("Notifications", { method: "delete", path: `${notifications}/push/subscriptions/{subscriptionId}`, summary: "Stop push to one browser", params: notificationsValidation.subscriptionParams });
