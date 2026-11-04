import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope, withRls } from "../../../lib/rls.js";
import { Permission } from "../../constants/permissions.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { localDateOf, localTimeToUtc, occurrencesBetween } from "../../utils/rrule.js";
import { auditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.interface.js";
import { documentsService } from "../documents/documents.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import { membersService } from "../members/members.service.js";
import { remindersService } from "../reminders/reminders.service.js";
import type {
  IAllBusinessesTasksQuery,
  ICalendarQuery,
  ICommentBody,
  ICreateTaskBody,
  IListTasksQuery,
  IUpdateTaskBody,
} from "./tasks.interface.js";

type TaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "CANCELLED";

const OPEN_STATUSES: TaskStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED"];

// Finished tasks can be reopened, which sends them back to TODO.
const ALLOWED_MOVES: Record<TaskStatus, TaskStatus[]> = {
  TODO: ["IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"],
  IN_PROGRESS: ["TODO", "BLOCKED", "DONE", "CANCELLED"],
  BLOCKED: ["TODO", "IN_PROGRESS", "CANCELLED"],
  DONE: ["TODO"],
  CANCELLED: ["TODO"],
};

// A day ahead of the due date. A task due sooner than that is reminded at the due time itself.
const DUE_REMINDER_LEAD_MINUTES = 24 * 60;
const MAX_CALENDAR_DAYS = 62;

const isOverdue = (task: { status: TaskStatus; dueAt: Date | null }, now = new Date()) =>
  task.dueAt !== null && task.dueAt < now && OPEN_STATUSES.includes(task.status);

const toDto = <T extends { status: TaskStatus; dueAt: Date | null }>(task: T) => ({ ...task, isOverdue: isOverdue(task) });

const assertAssignable = async (tx: Prisma.TransactionClient, businessId: string, userId: string) => {
  if (!(await membersService.isActiveMember(tx, businessId, userId))) {
    throw new AppError(422, ErrorCode.ASSIGNEE_NOT_MEMBER, { assigneeId: userId });
  }
};

// Keeps a task's automatic reminder in step with its due date, assignee and status.
const syncDueReminder = (
  tx: Prisma.TransactionClient,
  business: BusinessContext,
  task: { id: string; title: string; dueAt: Date | null; assigneeId: string | null; createdBy: string; status: TaskStatus },
) => {
  const now = Date.now();
  const leadMinutes = task.dueAt && task.dueAt.getTime() - now > DUE_REMINDER_LEAD_MINUTES * 60 * 1000 ? DUE_REMINDER_LEAD_MINUTES : 0;

  return remindersService.syncForSource(tx, business, {
    sourceType: "TASK",
    sourceId: task.id,
    title: task.title,
    startsAt: task.dueAt,
    rrule: null,
    leadMinutes,
    recipientUserId: task.assigneeId ?? task.createdBy,
    active: task.dueAt !== null && OPEN_STATUSES.includes(task.status),
  });
};

const tellAssignee = (tx: Prisma.TransactionClient, business: BusinessContext, taskId: string, assigneeId: string) =>
  publishEvent(tx, business, EventType.TASK_ASSIGNED, { taskId, assigneeId });

const create = (business: BusinessContext, body: ICreateTaskBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    if (body.assigneeId) await assertAssignable(tx, business.businessId, body.assigneeId);

    const task = await tx.task.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        title: body.title,
        description: body.description ?? null,
        assigneeId: body.assigneeId ?? null,
        priority: body.priority,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        createdBy: business.userId,
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "task.created",
      context,
      entityType: "task",
      entityId: task.id,
      after: { title: task.title, assigneeId: task.assigneeId, priority: task.priority, dueAt: task.dueAt },
    });
    if (task.assigneeId && task.assigneeId !== business.userId) await tellAssignee(tx, business, task.id, task.assigneeId);
    await syncDueReminder(tx, business, task);
    return toDto(task);
  });

const buildFilter = (query: IAllBusinessesTasksQuery, userId: string): Prisma.TaskWhereInput => {
  const dueAt = {
    ...(query.overdue ? { lt: new Date() } : {}),
    ...(query.dueFrom ? { gte: new Date(query.dueFrom) } : {}),
    ...(query.dueTo ? { lte: new Date(query.dueTo) } : {}),
  };
  return {
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.mine ? { assigneeId: userId } : {}),
    ...(query.overdue ? { status: { in: OPEN_STATUSES } } : {}),
    ...(Object.keys(dueAt).length > 0 ? { dueAt } : {}),
  };
};

const list = async (business: BusinessContext, query: IListTasksQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.task.findMany({
      where: {
        businessId: business.businessId,
        ...buildFilter(query, business.userId),
        ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
      },
      orderBy: { id: "desc" },
      ...pageArgs(query),
    }),
  );
  const page = toPage(rows, query.limit);
  return { items: page.items.map(toDto), nextCursor: page.nextCursor };
};

// The server works out which businesses to include. The client never sends that list.
const listAllBusinesses = async (auth: AuthContext, query: IAllBusinessesTasksQuery) => {
  const businesses = await membersService.listBusinessesWithPermission(auth.userId, Permission.TASKS_READ, false);
  const businessIds = businesses.map((business) => business.id);
  const names = new Map(businesses.map((business) => [business.id, business.name]));

  const rows = await withRls({ userId: auth.userId, workspaceId: auth.workspaceId, businessIds }, (tx) =>
    tx.task.findMany({
      where: { businessId: { in: businessIds }, ...buildFilter(query, auth.userId) },
      orderBy: { id: "desc" },
      ...pageArgs(query),
    }),
  );
  const page = toPage(rows, query.limit);
  return {
    items: page.items.map((task) => ({ ...toDto(task), businessName: names.get(task.businessId) ?? null })),
    nextCursor: page.nextCursor,
  };
};

const summary = (business: BusinessContext) =>
  withBusinessScope(business, async (tx) => {
    const where = { businessId: business.businessId };
    const [byStatus, overdue, mine] = await Promise.all([
      tx.task.groupBy({ by: ["status"], where, _count: { _all: true } }),
      tx.task.count({ where: { ...where, status: { in: OPEN_STATUSES }, dueAt: { lt: new Date() } } }),
      tx.task.count({ where: { ...where, status: { in: OPEN_STATUSES }, assigneeId: business.userId } }),
    ]);
    const counts = new Map(byStatus.map((row) => [row.status, row._count._all]));
    return {
      todo: counts.get("TODO") ?? 0,
      inProgress: counts.get("IN_PROGRESS") ?? 0,
      blocked: counts.get("BLOCKED") ?? 0,
      done: counts.get("DONE") ?? 0,
      cancelled: counts.get("CANCELLED") ?? 0,
      overdue,
      assignedToMe: mine,
    };
  });

// Tasks and reminder occurrences in date order, each on its day in the business's timezone.
const calendar = (business: BusinessContext, query: ICalendarQuery) => {
  const from = localTimeToUtc(query.from, "00:00", business.timezone);
  const nextDay = new Date(`${query.to}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const to = new Date(localTimeToUtc(nextDay.toISOString().slice(0, 10), "00:00", business.timezone).getTime() - 1);

  const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (days < 0 || days > MAX_CALENDAR_DAYS) throw new AppError(422, ErrorCode.DATE_RANGE_TOO_LONG, { maxDays: MAX_CALENDAR_DAYS });

  return withBusinessScope(business, async (tx) => {
    const [tasks, reminders] = await Promise.all([
      tx.task.findMany({
        where: { businessId: business.businessId, dueAt: { gte: from, lte: to } },
        select: { id: true, title: true, dueAt: true, status: true, priority: true, assigneeId: true },
      }),
      // Each task already appears through its due date, so its reminder isn't shown a second time.
      tx.reminder.findMany({
        where: { businessId: business.businessId, status: "ACTIVE", sourceType: { not: "TASK" } },
        select: { id: true, title: true, rrule: true, startsAt: true, timezone: true, sourceType: true, recipientUserId: true },
      }),
    ]);

    const items = [
      ...tasks.map((task) => ({
        kind: "TASK" as const,
        id: task.id,
        title: task.title,
        at: task.dueAt!,
        date: localDateOf(task.dueAt!, business.timezone),
        status: task.status,
        priority: task.priority,
        userId: task.assigneeId,
      })),
      ...reminders.flatMap((reminder) =>
        occurrencesBetween(reminder, from, to).map((at) => ({
          kind: "REMINDER" as const,
          id: reminder.id,
          title: reminder.title,
          at,
          date: localDateOf(at, business.timezone),
          sourceType: reminder.sourceType,
          userId: reminder.recipientUserId,
        })),
      ),
    ];
    return items.sort((a, b) => a.at.getTime() - b.at.getTime());
  });
};

const getOne = async (business: BusinessContext, taskId: string) => {
  const task = await withBusinessScope(business, (tx) =>
    tx.task.findFirst({
      where: { id: taskId, businessId: business.businessId },
      include: { attachments: { select: { documentId: true, createdAt: true } } },
    }),
  );
  if (!task) throw new AppError(404, ErrorCode.NOT_FOUND);
  return toDto(task);
};

// Locks the row, so two edits of one task run one after the other.
const lockOrThrow = async (tx: Prisma.TransactionClient, businessId: string, taskId: string) => {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM tasks WHERE id = ${taskId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
  if (!locked) throw new AppError(404, ErrorCode.NOT_FOUND);
  return tx.task.findUniqueOrThrow({ where: { id: taskId } });
};

const update = (business: BusinessContext, taskId: string, body: IUpdateTaskBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await lockOrThrow(tx, business.businessId, taskId);

    if (body.status && body.status !== before.status && !ALLOWED_MOVES[before.status].includes(body.status)) {
      throw new AppError(409, ErrorCode.TASK_STATUS_INVALID, { from: before.status, to: body.status });
    }
    if (body.assigneeId) await assertAssignable(tx, business.businessId, body.assigneeId);

    const finishing = body.status === "DONE" && before.status !== "DONE";
    const after = await tx.task.update({
      where: { id: taskId },
      data: {
        ...body,
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt ? new Date(body.dueAt) : null } : {}),
        ...(body.status ? { completedAt: finishing ? new Date() : body.status === "DONE" ? before.completedAt : null } : {}),
      },
    });

    const pick = (task: typeof before) => ({
      title: task.title,
      assigneeId: task.assigneeId,
      priority: task.priority,
      status: task.status,
      dueAt: task.dueAt,
    });
    await auditService.recordForBusiness(tx, business, {
      action: "task.updated",
      context,
      entityType: "task",
      entityId: taskId,
      before: pick(before),
      after: pick(after),
    });

    if (after.assigneeId && after.assigneeId !== before.assigneeId && after.assigneeId !== business.userId) {
      await auditService.recordForBusiness(tx, business, {
        action: "task.assigned",
        context,
        entityType: "task",
        entityId: taskId,
        after: { assigneeId: after.assigneeId },
      });
      await tellAssignee(tx, business, taskId, after.assigneeId);
    }
    await syncDueReminder(tx, business, after);
    return toDto(after);
  });

const listComments = (business: BusinessContext, taskId: string) =>
  withBusinessScope(business, async (tx) => {
    const task = await tx.task.findFirst({ where: { id: taskId, businessId: business.businessId }, select: { id: true } });
    if (!task) throw new AppError(404, ErrorCode.NOT_FOUND);
    return tx.taskComment.findMany({
      where: { taskId },
      orderBy: { id: "asc" },
      select: { id: true, authorId: true, body: true, createdAt: true },
    });
  });

const addComment = (business: BusinessContext, taskId: string, body: ICommentBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    await lockOrThrow(tx, business.businessId, taskId);
    const comment = await tx.taskComment.create({
      data: { workspaceId: business.workspaceId, businessId: business.businessId, taskId, authorId: business.userId, body: body.body },
      select: { id: true, authorId: true, body: true, createdAt: true },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "task.comment_added",
      context,
      entityType: "task",
      entityId: taskId,
      after: { commentId: comment.id },
    });
    await publishEvent(tx, business, EventType.TASK_COMMENTED, { taskId, commentId: comment.id });
    return comment;
  });

const attachDocument = (business: BusinessContext, taskId: string, documentId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    await lockOrThrow(tx, business.businessId, taskId);
    await documentsService.assertReady(tx, business.businessId, documentId);

    // Attaching the same document twice is harmless, so it isn't an error.
    const { count } = await tx.taskAttachment.createMany({
      data: { taskId, documentId, workspaceId: business.workspaceId, businessId: business.businessId, createdBy: business.userId },
      skipDuplicates: true,
    });
    if (count > 0) {
      await auditService.recordForBusiness(tx, business, {
        action: "task.document_attached",
        context,
        entityType: "task",
        entityId: taskId,
        after: { documentId },
      });
    }
    return { taskId, documentId };
  });

const detachDocument = (business: BusinessContext, taskId: string, documentId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    await lockOrThrow(tx, business.businessId, taskId);
    const { count } = await tx.taskAttachment.deleteMany({ where: { taskId, documentId } });
    if (count === 0) throw new AppError(404, ErrorCode.NOT_FOUND);
    await auditService.recordForBusiness(tx, business, {
      action: "task.document_detached",
      context,
      entityType: "task",
      entityId: taskId,
      before: { documentId },
    });
    return { removed: true };
  });

export const tasksService = {
  create,
  list,
  listAllBusinesses,
  summary,
  calendar,
  getOne,
  update,
  listComments,
  addComment,
  attachDocument,
  detachDocument,
};
