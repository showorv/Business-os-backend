import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { dateToMonth, monthToDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { percentOf } from "../../utils/money.js";
import { EventType, publishEvent, type EventActor } from "../../utils/outbox.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { assertMonthRange } from "../analytics/analytics.service.js";
import { auditService } from "../audit/audit.service.js";
import { categoriesService } from "../categories/categories.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { IBudgetLineBody, ICreateBudgetBody, IListBudgetsQuery, IUpdateBudgetBody } from "./budgets.interface.js";

const FULL_BUDGET_PERCENT = 100;

// Actuals come from the ledger, through the account each category posts to. Two categories sharing
// an account can't be told apart there, so one budget can't include both.
const assertLinesFit = async (tx: Prisma.TransactionClient, businessId: string, lines: IBudgetLineBody[]) => {
  const seenAccounts = new Set<string>();
  for (const line of lines) {
    const category = await categoriesService.getUsable(tx, businessId, line.categoryId);
    if (!category.ledgerAccountId) throw new AppError(409, ErrorCode.BUSINESS_NOT_PROVISIONED);
    if (seenAccounts.has(category.ledgerAccountId)) {
      throw new AppError(422, ErrorCode.BUDGET_LINE_DUPLICATE, { categoryId: line.categoryId });
    }
    seenAccounts.add(category.ledgerAccountId);
  }
};

const create = (business: BusinessContext, body: ICreateBudgetBody, context: RequestContext) => {
  assertMonthRange(body.startMonth, body.endMonth);

  return withBusinessScope(business, async (tx) => {
    await assertLinesFit(tx, business.businessId, body.lines);

    const owner = { workspaceId: business.workspaceId, businessId: business.businessId };
    const budget = await tx.budget.create({
      data: {
        ...owner,
        name: body.name,
        startMonth: monthToDate(body.startMonth),
        endMonth: monthToDate(body.endMonth),
        createdBy: business.userId,
        lines: {
          create: body.lines.map((line) => ({ ...owner, ...line, amountMinor: BigInt(line.amountMinor) })),
        },
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "budget.created",
      context,
      entityType: "budget",
      entityId: budget.id,
      after: { name: body.name, startMonth: body.startMonth, endMonth: body.endMonth, lines: body.lines.length },
    });
    return toSummary(budget);
  });
};

const toSummary = <T extends { startMonth: Date; endMonth: Date }>(budget: T) => ({
  ...budget,
  startMonth: dateToMonth(budget.startMonth),
  endMonth: dateToMonth(budget.endMonth),
});

const list = async (business: BusinessContext, query: IListBudgetsQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.budget.findMany({
      where: { businessId: business.businessId, ...(query.includeArchived ? {} : { status: "ACTIVE" }) },
      orderBy: { id: "desc" },
    }),
  );
  return rows.map(toSummary);
};

// How much of each line's category has actually been spent or earned in the budget's months.
const actualsFor = async (
  tx: Prisma.TransactionClient,
  budgetId: string,
) => {
  const rows = await tx.$queryRaw<{ line_id: string; actual: string }[]>`
    SELECT line.id AS line_id,
      COALESCE(SUM(
        CASE WHEN category.type = 'EXPENSE' THEN r.debit_minor - r.credit_minor ELSE r.credit_minor - r.debit_minor END
      ), 0)::text AS actual
    FROM budget_lines line
    JOIN budgets budget ON budget.id = line.budget_id
    JOIN categories category ON category.id = line.category_id
    LEFT JOIN ledger_monthly_rollups r
      ON r.ledger_account_id = category.ledger_account_id
      AND r.month BETWEEN budget.start_month AND budget.end_month
    WHERE line.budget_id = ${budgetId}::uuid
    GROUP BY line.id`;
  return new Map(rows.map((row) => [row.line_id, BigInt(row.actual)]));
};

const levelOf = (actual: bigint, amount: bigint, alertPercent: number) => {
  if (actual * 100n >= amount * BigInt(FULL_BUDGET_PERCENT)) return actual > amount ? "OVER" : "REACHED";
  return actual * 100n >= amount * BigInt(alertPercent) ? "NEAR" : "OK";
};

const getOne = (business: BusinessContext, budgetId: string) =>
  withBusinessScope(business, async (tx) => {
    const budget = await tx.budget.findFirst({
      where: { id: budgetId, businessId: business.businessId },
      include: {
        lines: {
          orderBy: { id: "asc" },
          include: {
            category: { select: { id: true, name: true, nameBn: true, type: true } },
            alerts: { orderBy: { percent: "asc" }, select: { percent: true, actualMinor: true, createdAt: true } },
          },
        },
      },
    });
    if (!budget) throw new AppError(404, ErrorCode.NOT_FOUND);

    const actuals = await actualsFor(tx, budgetId);
    const lines = budget.lines.map((line) => {
      const actualMinor = actuals.get(line.id) ?? 0n;
      return {
        id: line.id,
        category: line.category,
        amountMinor: line.amountMinor,
        alertPercent: line.alertPercent,
        actualMinor,
        remainingMinor: line.amountMinor - actualMinor,
        usedPercent: percentOf(actualMinor, line.amountMinor),
        level: levelOf(actualMinor, line.amountMinor, line.alertPercent),
        alerts: line.alerts,
      };
    });

    return {
      ...toSummary(budget),
      currency: business.baseCurrency,
      basis: "POSTED_ACTUALS" as const,
      lines,
    };
  });

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, budgetId: string) => {
  const budget = await tx.budget.findFirst({ where: { id: budgetId, businessId } });
  if (!budget) throw new AppError(404, ErrorCode.NOT_FOUND);
  return budget;
};

const update = (business: BusinessContext, budgetId: string, body: IUpdateBudgetBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await findOrThrow(tx, business.businessId, budgetId);
    const after = await tx.budget.update({ where: { id: budgetId }, data: body });
    await auditService.recordForBusiness(tx, business, {
      action: "budget.updated",
      context,
      entityType: "budget",
      entityId: budgetId,
      before: { name: before.name, status: before.status },
      after: { name: after.name, status: after.status },
    });
    return toSummary(after);
  });

// Adds a line, or changes the amount of the category's existing line.
const setLine = (business: BusinessContext, budgetId: string, body: IBudgetLineBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    await findOrThrow(tx, business.businessId, budgetId);

    const others = await tx.budgetLine.findMany({
      where: { budgetId, categoryId: { not: body.categoryId } },
      select: { categoryId: true, amountMinor: true, alertPercent: true },
    });
    await assertLinesFit(tx, business.businessId, [
      body,
      ...others.map((line) => ({ ...line, amountMinor: String(line.amountMinor) })),
    ]);

    const amountMinor = BigInt(body.amountMinor);
    const line = await tx.budgetLine.upsert({
      where: { budgetId_categoryId: { budgetId, categoryId: body.categoryId } },
      create: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        budgetId,
        categoryId: body.categoryId,
        amountMinor,
        alertPercent: body.alertPercent,
      },
      update: { amountMinor, alertPercent: body.alertPercent },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "budget.line_set",
      context,
      entityType: "budget",
      entityId: budgetId,
      after: { categoryId: body.categoryId, amountMinor, alertPercent: body.alertPercent },
    });
    return line;
  });

// Runs in the worker after each posting. The unique index makes each threshold fire only once, so
// this is safe to run repeatedly and in parallel.
const checkThresholds = (actor: EventActor) =>
  withBusinessScope(actor, async (tx) => {
    const budgets = await tx.budget.findMany({
      where: { businessId: actor.businessId, status: "ACTIVE" },
      select: { id: true, lines: { select: { id: true, amountMinor: true, alertPercent: true } } },
    });

    for (const budget of budgets) {
      const actuals = await actualsFor(tx, budget.id);

      for (const line of budget.lines) {
        const actualMinor = actuals.get(line.id) ?? 0n;
        for (const percent of new Set([line.alertPercent, FULL_BUDGET_PERCENT])) {
          if (actualMinor * 100n < line.amountMinor * BigInt(percent)) continue;

          const { count } = await tx.budgetAlert.createMany({
            data: {
              workspaceId: actor.workspaceId,
              businessId: actor.businessId,
              budgetLineId: line.id,
              percent,
              actualMinor,
            },
            skipDuplicates: true,
          });
          if (count > 0) {
            await publishEvent(tx, actor, EventType.BUDGET_THRESHOLD_REACHED, { budgetId: budget.id, budgetLineId: line.id, percent });
          }
        }
      }
    }
  });

export const budgetsService = { create, list, getOne, update, setLine, checkThresholds };
