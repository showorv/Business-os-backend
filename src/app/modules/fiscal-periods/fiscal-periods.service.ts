import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { Permission } from "../../constants/permissions.js";
import { addDays, fromDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { FiscalActor, IListPeriodsQuery, PeriodRules } from "./fiscal-periods.interface.js";

const MONTHS_IN_YEAR = 12;

const toDto = <T extends { startDate: Date; endDate: Date }>(period: T) => ({
  ...period,
  startDate: fromDbDate(period.startDate),
  endDate: fromDbDate(period.endDate),
});

// The calendar year a date's fiscal year starts in. With a July start, March 2027 belongs to 2026.
export const fiscalYearOf = (date: Date, startMonth: number) =>
  date.getUTCMonth() + 1 >= startMonth ? date.getUTCFullYear() : date.getUTCFullYear() - 1;

// Twelve month-long periods. Day 0 of a month is the last day of the month before.
export const periodsForYear = (fiscalYear: number, startMonth: number) =>
  Array.from({ length: MONTHS_IN_YEAR }, (_, index) => ({
    startDate: new Date(Date.UTC(fiscalYear, startMonth - 1 + index, 1)),
    endDate: new Date(Date.UTC(fiscalYear, startMonth + index, 0)),
  }));

const ensureYear = (tx: Prisma.TransactionClient, actor: FiscalActor, fiscalYear: number) =>
  tx.fiscalPeriod.createMany({
    data: periodsForYear(fiscalYear, actor.fiscalYearStartMonth).map((period) => ({
      ...period,
      fiscalYear,
      workspaceId: actor.workspaceId,
      businessId: actor.businessId,
    })),
    skipDuplicates: true,
  });

// New years open by themselves going forward, up to a year ahead, so January never blocks posting.
// Older years must be opened on purpose, or by an opening balance.
const openMissingYears = async (tx: Prisma.TransactionClient, actor: FiscalActor, date: Date, rules: PeriodRules) => {
  const target = fiscalYearOf(date, actor.fiscalYearStartMonth);
  if (rules.allowBackfill) return ensureYear(tx, actor, target);

  const latest = await tx.fiscalPeriod.aggregate({ where: { businessId: actor.businessId }, _max: { fiscalYear: true } });
  const latestYear = latest._max.fiscalYear;
  const isTooFarAhead = date > addDays(new Date(), 366);
  if (latestYear === null || target <= latestYear || isTooFarAhead) {
    throw new AppError(422, ErrorCode.FISCAL_PERIOD_NOT_FOUND, { date: fromDbDate(date), fiscalYear: target });
  }
  for (let year = latestYear + 1; year <= target; year++) await ensureYear(tx, actor, year);
};

const findPeriodRow = async (tx: Prisma.TransactionClient, businessId: string, date: Date) => {
  const day = fromDbDate(date);
  // FOR SHARE: a period cannot close in the middle of this transaction.
  const [period] = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status::text FROM fiscal_periods
    WHERE business_id = ${businessId}::uuid AND start_date <= ${day}::date AND end_date >= ${day}::date
    FOR SHARE`;
  return period;
};

// The period an entry on this date belongs to, or an error saying why it can't be posted.
const resolveForPosting = async (tx: Prisma.TransactionClient, actor: FiscalActor, date: Date, rules: PeriodRules = {}) => {
  let period = await findPeriodRow(tx, actor.businessId, date);
  if (!period) {
    await openMissingYears(tx, actor, date, rules);
    period = await findPeriodRow(tx, actor.businessId, date);
  }
  if (!period) throw new AppError(422, ErrorCode.FISCAL_PERIOD_NOT_FOUND, { date: fromDbDate(date) });

  if (period.status === "CLOSED") throw new AppError(409, ErrorCode.PERIOD_CLOSED, { date: fromDbDate(date) });
  if (period.status === "SOFT_CLOSED" && !rules.allowSoftClosed) {
    throw new AppError(409, ErrorCode.PERIOD_SOFT_CLOSED, { date: fromDbDate(date) });
  }
  return period.id;
};

const list = async (business: BusinessContext, query: IListPeriodsQuery) => {
  const periods = await withBusinessScope(business, (tx) =>
    tx.fiscalPeriod.findMany({
      where: { businessId: business.businessId, ...(query.fiscalYear ? { fiscalYear: query.fiscalYear } : {}) },
      orderBy: { startDate: "asc" },
    }),
  );
  return periods.map(toDto);
};

const createYear = async (business: BusinessContext, fiscalYear: number, context: RequestContext) => {
  await withBusinessScope(business, async (tx) => {
    const { count } = await ensureYear(tx, business, fiscalYear);
    if (count > 0) {
      await auditService.recordForBusiness(tx, business, {
        action: "fiscal_year.created",
        context,
        entityType: "business",
        entityId: business.businessId,
        after: { fiscalYear },
      });
    }
  });
  return list(business, { fiscalYear });
};

const assertEarlierPeriodsClosed = async (tx: Prisma.TransactionClient, businessId: string, before: Date) => {
  const notClosed = await tx.fiscalPeriod.count({
    where: { businessId, startDate: { lt: before }, status: { not: "CLOSED" } },
  });
  if (notClosed > 0) throw new AppError(409, ErrorCode.PERIOD_ORDER, { notClosed });
};

const changeStatus = (
  business: BusinessContext,
  periodId: string,
  status: "OPEN" | "SOFT_CLOSED" | "CLOSED",
  context: RequestContext,
) =>
  withBusinessScope(business, async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM fiscal_periods WHERE id = ${periodId}::uuid AND business_id = ${business.businessId}::uuid FOR UPDATE`;
    if (!locked) throw new AppError(404, ErrorCode.NOT_FOUND);
    const period = await tx.fiscalPeriod.findUniqueOrThrow({ where: { id: periodId } });

    // CLOSED is final: corrections go into the current period.
    if (period.status === "CLOSED" || period.status === status) {
      throw new AppError(409, ErrorCode.INVALID_STATUS_CHANGE, { from: period.status, to: status });
    }
    if (status === "OPEN" && !business.permissions.includes(Permission.BUSINESS_MANAGE)) {
      throw new AppError(403, ErrorCode.PERMISSION_DENIED, { permission: Permission.BUSINESS_MANAGE });
    }
    if (status === "CLOSED") {
      await assertEarlierPeriodsClosed(tx, business.businessId, period.startDate);
      // The year's last period closes through the year-end close, which also posts the closing entry.
      const yearEnd = await tx.fiscalPeriod.aggregate({
        where: { businessId: business.businessId, fiscalYear: period.fiscalYear },
        _max: { endDate: true },
      });
      if (yearEnd._max.endDate?.getTime() === period.endDate.getTime()) {
        throw new AppError(409, ErrorCode.USE_YEAR_CLOSE, { fiscalYear: period.fiscalYear });
      }
    }

    const after = await tx.fiscalPeriod.update({
      where: { id: periodId },
      data: { status, ...(status === "CLOSED" ? { closedAt: new Date(), closedBy: business.userId } : {}) },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "period.status_changed",
      context,
      entityType: "fiscal_period",
      entityId: periodId,
      before: { status: period.status },
      after: { status, startDate: fromDbDate(period.startDate) },
    });
    return toDto(after);
  });

// For the year-end close in journals.service.ts.
const getYearForClosing = async (tx: Prisma.TransactionClient, businessId: string, fiscalYear: number) => {
  const periods = await tx.$queryRaw<{ id: string; status: string; start_date: Date; end_date: Date }[]>`
    SELECT id, status::text, start_date, end_date FROM fiscal_periods
    WHERE business_id = ${businessId}::uuid AND fiscal_year = ${fiscalYear}
    ORDER BY start_date FOR UPDATE`;
  if (periods.length === 0) throw new AppError(404, ErrorCode.NOT_FOUND);
  if (periods.every((period) => period.status === "CLOSED")) {
    throw new AppError(409, ErrorCode.YEAR_ALREADY_CLOSED, { fiscalYear });
  }
  const open = periods.filter((period) => period.status === "OPEN").length;
  if (open > 0) throw new AppError(409, ErrorCode.YEAR_HAS_OPEN_PERIODS, { open });

  await assertEarlierPeriodsClosed(tx, businessId, periods[0]!.start_date);
  return { startDate: periods[0]!.start_date, endDate: periods.at(-1)!.end_date };
};

const closeYearPeriods = (tx: Prisma.TransactionClient, businessId: string, fiscalYear: number, userId: string) =>
  tx.fiscalPeriod.updateMany({
    where: { businessId, fiscalYear, status: { not: "CLOSED" } },
    data: { status: "CLOSED", closedAt: new Date(), closedBy: userId },
  });

export const fiscalPeriodsService = {
  ensureYear,
  resolveForPosting,
  list,
  createYear,
  changeStatus,
  getYearForClosing,
  closeYearPeriods,
};

