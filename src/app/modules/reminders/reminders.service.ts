import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { nextFiring } from "../../utils/rrule.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import { membersService } from "../members/members.service.js";
import type { ICreateReminderBody, IListRemindersQuery, ISourceReminder, IUpdateReminderBody } from "./reminders.interface.js";

const ALL_CHANNELS = ["IN_APP", "EMAIL", "PUSH"];

// Saved with the change, so the worker makes its BullMQ job only if the change committed.
const tellWorker = (tx: Prisma.TransactionClient, business: BusinessContext, reminderId: string) =>
  publishEvent(tx, business, EventType.REMINDER_CHANGED, { reminderId });

const assertRecipient = async (tx: Prisma.TransactionClient, businessId: string, userId: string) => {
  if (!(await membersService.isActiveMember(tx, businessId, userId))) {
    throw new AppError(422, ErrorCode.ASSIGNEE_NOT_MEMBER, { recipientUserId: userId });
  }
};

const create = (business: BusinessContext, body: ICreateReminderBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const recipientUserId = body.recipientUserId ?? business.userId;
    await assertRecipient(tx, business.businessId, recipientUserId);

    const startsAt = new Date(body.startsAt);
    const rrule = body.rrule ?? null;
    const timezone = body.timezone ?? business.timezone;
    const firing = nextFiring({ rrule, startsAt, timezone }, body.leadMinutes, new Date());
    if (!firing) throw new AppError(422, ErrorCode.REMINDER_NO_FUTURE_OCCURRENCE);

    const reminder = await tx.reminder.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        title: body.title,
        rrule,
        startsAt,
        timezone,
        leadMinutes: body.leadMinutes,
        nextOccurrenceAt: firing.occurrenceAt,
        nextFireAt: firing.fireAt,
        channels: body.channels,
        recipientUserId,
        createdBy: business.userId,
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "reminder.created",
      context,
      entityType: "reminder",
      entityId: reminder.id,
      after: { title: body.title, rrule, startsAt, timezone, recipientUserId },
    });
    await tellWorker(tx, business, reminder.id);
    return reminder;
  });

const list = async (business: BusinessContext, query: IListRemindersQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.reminder.findMany({
      where: {
        businessId: business.businessId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.sourceType ? { sourceType: query.sourceType } : {}),
        ...(query.mine ? { recipientUserId: business.userId } : {}),
      },
      orderBy: { id: "desc" },
      ...pageArgs(query),
    }),
  );
  return toPage(rows, query.limit);
};

const getOne = async (business: BusinessContext, reminderId: string) => {
  const reminder = await withBusinessScope(business, (tx) =>
    tx.reminder.findFirst({ where: { id: reminderId, businessId: business.businessId } }),
  );
  if (!reminder) throw new AppError(404, ErrorCode.NOT_FOUND);
  return reminder;
};

const update = (business: BusinessContext, reminderId: string, body: IUpdateReminderBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM reminders WHERE id = ${reminderId}::uuid AND business_id = ${business.businessId}::uuid FOR UPDATE`;
    if (!locked) throw new AppError(404, ErrorCode.NOT_FOUND);

    const before = await tx.reminder.findUniqueOrThrow({ where: { id: reminderId } });
    // Otherwise the next change to the task or schedule would silently undo the edit.
    if (before.sourceType !== "MANUAL") throw new AppError(409, ErrorCode.REMINDER_MANAGED_BY_SOURCE, { sourceType: before.sourceType });
    if (before.status === "COMPLETED" || before.status === "CANCELLED") {
      throw new AppError(409, ErrorCode.REMINDER_NOT_EDITABLE, { status: before.status });
    }
    if (body.recipientUserId) await assertRecipient(tx, business.businessId, body.recipientUserId);

    const status = body.status ?? before.status;
    const recurrence = {
      rrule: body.rrule === undefined ? before.rrule : body.rrule,
      startsAt: body.startsAt ? new Date(body.startsAt) : before.startsAt,
      timezone: body.timezone ?? before.timezone,
    };
    const leadMinutes = body.leadMinutes ?? before.leadMinutes;
    const firing = status === "ACTIVE" ? nextFiring(recurrence, leadMinutes, new Date()) : null;
    if (status === "ACTIVE" && !firing) throw new AppError(422, ErrorCode.REMINDER_NO_FUTURE_OCCURRENCE);

    const after = await tx.reminder.update({
      where: { id: reminderId },
      data: {
        ...body,
        ...recurrence,
        leadMinutes,
        status,
        // Changing nextFireAt is what makes any job already queued go stale. See fireReminder.
        nextOccurrenceAt: firing?.occurrenceAt ?? null,
        nextFireAt: firing?.fireAt ?? null,
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "reminder.updated",
      context,
      entityType: "reminder",
      entityId: reminderId,
      before: { title: before.title, rrule: before.rrule, startsAt: before.startsAt, status: before.status },
      after: { title: after.title, rrule: after.rrule, startsAt: after.startsAt, status: after.status },
    });
    await tellWorker(tx, business, reminderId);
    return after;
  });

// Creates or updates the reminder a task or schedule looks after, in that change's transaction.
const syncForSource = async (tx: Prisma.TransactionClient, business: BusinessContext, source: ISourceReminder) => {
  const existing = await tx.reminder.findFirst({
    where: { businessId: business.businessId, sourceType: source.sourceType, sourceId: source.sourceId },
  });

  const timezone = source.timezone ?? business.timezone;
  const firing =
    source.active && source.startsAt
      ? nextFiring({ rrule: source.rrule, startsAt: source.startsAt, timezone }, source.leadMinutes, new Date())
      : null;

  if (!firing) {
    if (existing && existing.status === "ACTIVE") {
      await tx.reminder.update({ where: { id: existing.id }, data: { status: "CANCELLED", nextFireAt: null, nextOccurrenceAt: null } });
    }
    return;
  }

  const values = {
    title: source.title,
    rrule: source.rrule,
    startsAt: source.startsAt!,
    timezone,
    leadMinutes: source.leadMinutes,
    recipientUserId: source.recipientUserId,
    nextOccurrenceAt: firing.occurrenceAt,
    nextFireAt: firing.fireAt,
    status: "ACTIVE" as const,
  };
  const reminder = existing
    ? await tx.reminder.update({ where: { id: existing.id }, data: values })
    : await tx.reminder.create({
        data: {
          ...values,
          workspaceId: business.workspaceId,
          businessId: business.businessId,
          channels: ALL_CHANNELS,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          createdBy: business.userId,
        },
      });
  await tellWorker(tx, business, reminder.id);
};

export const remindersService = { create, list, getOne, update, syncForSource };
