import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { LedgerCode } from "../../constants/chartOfAccounts.js";
import { Permission } from "../../constants/permissions.js";
import { sha256Hex } from "../../utils/crypto.js";
import { fromDbDate, todayInTimezone, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { localDateOf, localTimeToUtc, nextOccurrence } from "../../utils/rrule.js";
import { auditService } from "../audit/audit.service.js";
import { categoriesService } from "../categories/categories.service.js";
import { ledgerAccountsService } from "../ledger-accounts/ledger-accounts.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import { membersService } from "../members/members.service.js";
import { NotificationType } from "../notifications/notifications.interface.js";
import { notificationsService } from "../notifications/notifications.service.js";
import { remindersService } from "../reminders/reminders.service.js";
import type { ITransactionDraft } from "../transactions/transactions.interface.js";
import { transactionsService } from "../transactions/transactions.service.js";
import type { ICreateScheduleBody, IListSchedulesQuery, IUpdateScheduleBody } from "./recurring-schedules.interface.js";

// However long the worker was down, one pass catches up this many occurrences of a schedule. The next
// pass carries on, so a backlog can't hold up everything else.
const MAX_CATCH_UP = 12;
const REMINDER_TIME = "09:00";

type StoredSchedule = Prisma.RecurringScheduleGetPayload<object>;

const toDto = <T extends { startDate: Date }>(schedule: T) => ({ ...schedule, startDate: fromDbDate(schedule.startDate) });

const recurrenceOf = (schedule: { rrule: string; startDate: Date; timezone: string }) => ({
  rrule: schedule.rrule,
  startsAt: localTimeToUtc(fromDbDate(schedule.startDate), "00:00", schedule.timezone),
  timezone: schedule.timezone,
});

// A salary must land on the Salaries Expense account, so it can't use just any category.
const salaryCategoryId = async (tx: Prisma.TransactionClient, businessId: string, chosen: string | null | undefined) => {
  const salaries = await ledgerAccountsService.getByCode(tx, businessId, LedgerCode.SALARIES);
  if (chosen) {
    const category = await categoriesService.getUsable(tx, businessId, chosen);
    if (category.ledgerAccountId !== salaries.id) throw new AppError(422, ErrorCode.SALARY_CATEGORY_INVALID, { categoryId: chosen });
    return chosen;
  }
  const category = await tx.category.findFirst({ where: { businessId, ledgerAccountId: salaries.id, isActive: true }, select: { id: true } });
  if (!category) throw new AppError(422, ErrorCode.SALARY_CATEGORY_INVALID);
  return category.id;
};

const assertMayAutoPost = (business: BusinessContext, autoPost: boolean) => {
  if (autoPost && !business.permissions.includes(Permission.LEDGER_POST)) {
    throw new AppError(403, ErrorCode.PERMISSION_DENIED, { permission: Permission.LEDGER_POST });
  }
};

const syncReminder = (tx: Prisma.TransactionClient, business: BusinessContext, schedule: StoredSchedule) =>
  remindersService.syncForSource(tx, business, {
    sourceType: "RECURRING_SCHEDULE",
    sourceId: schedule.id,
    title: schedule.name,
    startsAt: localTimeToUtc(fromDbDate(schedule.startDate), REMINDER_TIME, schedule.timezone),
    rrule: schedule.rrule,
    timezone: schedule.timezone,
    leadMinutes: (schedule.remindDaysBefore ?? 0) * 24 * 60,
    recipientUserId: schedule.createdBy,
    active: schedule.status === "ACTIVE" && schedule.remindDaysBefore !== null,
  });

const create = (business: BusinessContext, body: ICreateScheduleBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    assertMayAutoPost(business, body.autoPost);

    const timezone = body.timezone ?? business.timezone;
    // Starting in the past would quietly create a backlog of old transactions.
    if (body.startDate < todayInTimezone(timezone)) throw new AppError(422, ErrorCode.SCHEDULE_NO_FUTURE_OCCURRENCE);

    const isSalary = body.kind === "SALARY";
    const type = isSalary ? "EXPENSE" : (body.type ?? "EXPENSE");
    const categoryId = isSalary ? await salaryCategoryId(tx, business.businessId, body.categoryId) : (body.categoryId ?? null);

    const draft: ITransactionDraft = {
      type,
      accountId: body.accountId,
      toAccountId: body.toAccountId ?? null,
      categoryId,
      contactId: null,
      amountMinor: BigInt(body.amountMinor),
      feeMinor: BigInt(body.feeMinor),
      txnDate: toDbDate(body.startDate),
      referenceNo: null,
    };
    await transactionsService.assertDraftValid(tx, business.businessId, draft);

    const startDate = toDbDate(body.startDate);
    const recurrence = recurrenceOf({ rrule: body.rrule, startDate, timezone });
    const nextRunAt = nextOccurrence(recurrence, new Date(recurrence.startsAt.getTime() - 1));
    if (!nextRunAt) throw new AppError(422, ErrorCode.SCHEDULE_NO_FUTURE_OCCURRENCE);

    const schedule = await tx.recurringSchedule.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        name: body.name,
        kind: body.kind,
        rrule: body.rrule,
        startDate,
        timezone,
        nextRunAt,
        type,
        accountId: body.accountId,
        toAccountId: body.toAccountId ?? null,
        categoryId,
        amountMinor: draft.amountMinor,
        feeMinor: draft.feeMinor,
        description: body.description ?? null,
        autoPost: body.autoPost,
        remindDaysBefore: body.remindDaysBefore ?? null,
        createdBy: business.userId,
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "recurring_schedule.created",
      context,
      entityType: "recurring_schedule",
      entityId: schedule.id,
      after: { name: body.name, kind: body.kind, rrule: body.rrule, amountMinor: draft.amountMinor, autoPost: body.autoPost },
    });
    await syncReminder(tx, business, schedule);
    return toDto(schedule);
  });

const list = async (business: BusinessContext, query: IListSchedulesQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.recurringSchedule.findMany({
      where: {
        businessId: business.businessId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
      },
      orderBy: { id: "desc" },
      ...pageArgs(query),
    }),
  );
  const page = toPage(rows, query.limit);
  return { items: page.items.map(toDto), nextCursor: page.nextCursor };
};

const RECENT_RUNS = 24;

const getOne = async (business: BusinessContext, scheduleId: string) => {
  const schedule = await withBusinessScope(business, (tx) =>
    tx.recurringSchedule.findFirst({
      where: { id: scheduleId, businessId: business.businessId },
      include: {
        runs: {
          orderBy: { occurrenceDate: "desc" },
          take: RECENT_RUNS,
          select: { id: true, occurrenceDate: true, status: true, transactionId: true, errorCode: true, createdAt: true },
        },
      },
    }),
  );
  if (!schedule) throw new AppError(404, ErrorCode.NOT_FOUND);
  return {
    ...toDto(schedule),
    runs: schedule.runs.map((run) => ({ ...run, occurrenceDate: fromDbDate(run.occurrenceDate) })),
  };
};

const update = (business: BusinessContext, scheduleId: string, body: IUpdateScheduleBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM recurring_schedules WHERE id = ${scheduleId}::uuid AND business_id = ${business.businessId}::uuid FOR UPDATE`;
    if (!locked) throw new AppError(404, ErrorCode.NOT_FOUND);

    const before = await tx.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    if (before.status === "ENDED") throw new AppError(409, ErrorCode.SCHEDULE_NOT_ACTIVE, { status: before.status });
    if (body.autoPost !== undefined) assertMayAutoPost(business, body.autoPost);

    const categoryId =
      before.kind === "SALARY"
        ? await salaryCategoryId(tx, business.businessId, body.categoryId === undefined ? before.categoryId : body.categoryId)
        : body.categoryId === undefined
          ? before.categoryId
          : body.categoryId;

    await transactionsService.assertDraftValid(tx, business.businessId, {
      type: before.type,
      accountId: body.accountId ?? before.accountId,
      toAccountId: body.toAccountId === undefined ? before.toAccountId : body.toAccountId,
      categoryId,
      amountMinor: body.amountMinor ? BigInt(body.amountMinor) : before.amountMinor,
      feeMinor: body.feeMinor ? BigInt(body.feeMinor) : before.feeMinor,
      txnDate: before.startDate,
      contactId: null,
        referenceNo: null,
    });

    const status = body.status ?? before.status;
    const rrule = body.rrule ?? before.rrule;
    // Resuming or changing the rule looks forward from now, so paused months are not made up later.
    const recalculate = status === "ACTIVE" && (before.status !== "ACTIVE" || rrule !== before.rrule);
    const nextRunAt = recalculate ? nextOccurrence(recurrenceOf({ ...before, rrule }), new Date()) : before.nextRunAt;
    if (recalculate && !nextRunAt) throw new AppError(422, ErrorCode.SCHEDULE_NO_FUTURE_OCCURRENCE);

    const { amountMinor, feeMinor, ...fields } = body;
    const after = await tx.recurringSchedule.update({
      where: { id: scheduleId },
      data: {
        ...fields,
        categoryId,
        rrule,
        status,
        nextRunAt: status === "ENDED" ? null : nextRunAt,
        ...(amountMinor ? { amountMinor: BigInt(amountMinor) } : {}),
        ...(feeMinor ? { feeMinor: BigInt(feeMinor) } : {}),
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "recurring_schedule.updated",
      context,
      entityType: "recurring_schedule",
      entityId: scheduleId,
      before: { name: before.name, rrule: before.rrule, amountMinor: before.amountMinor, status: before.status, autoPost: before.autoPost },
      after: { name: after.name, rrule: after.rrule, amountMinor: after.amountMinor, status: after.status, autoPost: after.autoPost },
    });
    await syncReminder(tx, business, after);
    return toDto(after);
  });

// ---------------------------------------------------------------------------
// Running. The worker calls this on a timer, and the /run endpoint calls it on request.
// ---------------------------------------------------------------------------

const recordRun = async (schedule: StoredSchedule, occurrenceDate: string, outcome: { transactionId: string } | { errorCode: string }) => {
  await prisma.recurringRun.createMany({
    data: {
      workspaceId: schedule.workspaceId,
      businessId: schedule.businessId,
      scheduleId: schedule.id,
      occurrenceDate: toDbDate(occurrenceDate),
      ...("transactionId" in outcome
        ? { status: "CREATED" as const, transactionId: outcome.transactionId }
        : { status: "FAILED" as const, errorCode: outcome.errorCode }),
    },
    skipDuplicates: true,
  });
};

const tellAboutFailure = async (schedule: StoredSchedule, recipients: string[], occurrenceDate: string, errorCode: string) => {
  await notificationsService.notifySafely(
    recipients.map((userId) => ({
      type: NotificationType.RECURRING_FAILED,
      userId,
      workspaceId: schedule.workspaceId,
      businessId: schedule.businessId,
      params: { scheduleId: schedule.id, scheduleName: schedule.name, occurrenceDate, errorCode },
      entityType: "recurring_schedule",
      entityId: schedule.id,
      dedupeKey: `${NotificationType.RECURRING_FAILED}:${schedule.id}:${occurrenceDate}:${userId}`,
    })),
  );
};

// A business-rule refusal (a closed period, say) won't fix itself by retrying, so it is recorded and
// the person told. Any other error is thrown, and the job retries.
const runOccurrence = async (schedule: StoredSchedule, occurrenceDate: string) => {
  const existing = await prisma.recurringRun.findUnique({
    where: { scheduleId_occurrenceDate: { scheduleId: schedule.id, occurrenceDate: toDbDate(occurrenceDate) } },
  });
  if (existing) return;

  // It runs as the person who set it up, with what they may do today.
  const actor = await membersService.resolveContext(schedule.createdBy, schedule.businessId);
  if (!actor) {
    await recordRun(schedule, occurrenceDate, { errorCode: ErrorCode.PERMISSION_DENIED });
    await prisma.recurringSchedule.update({ where: { id: schedule.id }, data: { status: "PAUSED" } });
    const managers = await membersService.listUserIdsWithPermission(schedule.businessId, Permission.BUSINESS_MANAGE);
    await tellAboutFailure(schedule, managers, occurrenceDate, ErrorCode.PERMISSION_DENIED);
    return;
  }

  const context: RequestContext = { ip: null, userAgent: "worker", requestId: `recurring-${schedule.id}-${occurrenceDate}` };
  // The key means that if this job dies after creating the transaction, the retry finds that one.
  const key = `recurring-${schedule.id}-${occurrenceDate}`;

  try {
    if (!actor.permissions.includes(Permission.FINANCE_WRITE)) {
      throw new AppError(403, ErrorCode.PERMISSION_DENIED, { permission: Permission.FINANCE_WRITE });
    }
    const { body } = await transactionsService.create(
      actor,
      {
        type: schedule.type,
        accountId: schedule.accountId,
        ...(schedule.toAccountId ? { toAccountId: schedule.toAccountId } : {}),
        ...(schedule.categoryId ? { categoryId: schedule.categoryId } : {}),
        amountMinor: schedule.amountMinor.toString(),
        feeMinor: schedule.feeMinor.toString(),
        txnDate: occurrenceDate,
        ...(schedule.description ? { description: schedule.description } : {}),
        postNow: schedule.autoPost,
      },
      { key, requestHash: sha256Hex(key) },
      context,
      { source: "RECURRING" },
    );
    await recordRun(schedule, occurrenceDate, { transactionId: body.id });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await recordRun(schedule, occurrenceDate, { errorCode: error.code });
    await tellAboutFailure(schedule, [schedule.createdBy], occurrenceDate, error.code);
  }
};

// Runs everything due on one schedule, moving nextRunAt forward only after each one is saved. So a
// crash repeats an occurrence, which the run row and idempotency key then make harmless.
const runDue = async (scheduleId: string) => {
  for (let count = 0; count < MAX_CATCH_UP; count += 1) {
    const schedule = await prisma.recurringSchedule.findUnique({ where: { id: scheduleId } });
    if (!schedule || schedule.status !== "ACTIVE" || !schedule.nextRunAt || schedule.nextRunAt > new Date()) return;

    await runOccurrence(schedule, localDateOf(schedule.nextRunAt, schedule.timezone));

    const nextRunAt = nextOccurrence(recurrenceOf(schedule), schedule.nextRunAt);
    await prisma.recurringSchedule.updateMany({
      // Skipped if a pause or another worker already changed it.
      where: { id: scheduleId, nextRunAt: schedule.nextRunAt, status: "ACTIVE" },
      data: nextRunAt ? { nextRunAt } : { nextRunAt: null, status: "ENDED" },
    });
  }
};

// The worker's timer. Skips businesses that aren't active.
const runAllDue = async () => {
  const due = await prisma.recurringSchedule.findMany({
    where: { status: "ACTIVE", nextRunAt: { lte: new Date() }, business: { status: "ACTIVE" } },
    select: { id: true },
  });
  for (const { id } of due) await runDue(id);
  return due.length;
};

const runDueForRequest = async (business: BusinessContext, scheduleId: string) => {
  const schedule = await getOne(business, scheduleId);
  if (schedule.status !== "ACTIVE") throw new AppError(409, ErrorCode.SCHEDULE_NOT_ACTIVE, { status: schedule.status });
  await runDue(scheduleId);
  return getOne(business, scheduleId);
};

export const recurringSchedulesService = { create, list, getOne, update, runDue, runAllDue, runDueForRequest };
