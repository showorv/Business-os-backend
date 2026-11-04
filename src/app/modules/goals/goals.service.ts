import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { dateToMonth, monthToDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { percentOf } from "../../utils/money.js";
import { EventType, publishEvent, type EventActor } from "../../utils/outbox.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { assertMonthRange, balancesByBusiness, profitByBusiness } from "../analytics/analytics.service.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { ICreateGoalBody, IListGoalsQuery, IUpdateGoalBody } from "./goals.interface.js";

interface GoalRow {
  id: string;
  metric: "REVENUE" | "NET_PROFIT" | "CASH_BALANCE";
  targetMinor: bigint;
  startMonth: Date;
  endMonth: Date;
}

// Revenue and profit add up over the goal's months. A cash goal is the balance at its end month.
const currentValue = async (tx: Prisma.TransactionClient, businessId: string, goal: GoalRow) => {
  const from = dateToMonth(goal.startMonth);
  const to = dateToMonth(goal.endMonth);

  if (goal.metric === "CASH_BALANCE") {
    const balances = await balancesByBusiness(tx, [businessId], to);
    return BigInt(balances.get(businessId)?.cash ?? 0);
  }
  const profit = (await profitByBusiness(tx, [businessId], from, to)).get(businessId);
  const revenue = profit?.revenue ?? 0n;
  return goal.metric === "REVENUE" ? revenue : revenue - (profit?.expenses ?? 0n);
};

const withProgress = async <T extends GoalRow>(tx: Prisma.TransactionClient, businessId: string, goal: T) => {
  const currentMinor = await currentValue(tx, businessId, goal);
  return {
    ...goal,
    startMonth: dateToMonth(goal.startMonth),
    endMonth: dateToMonth(goal.endMonth),
    currentMinor,
    remainingMinor: goal.targetMinor > currentMinor ? goal.targetMinor - currentMinor : 0n,
    progressPercent: percentOf(currentMinor, goal.targetMinor),
  };
};

const create = (business: BusinessContext, body: ICreateGoalBody, context: RequestContext) => {
  assertMonthRange(body.startMonth, body.endMonth);

  return withBusinessScope(business, async (tx) => {
    const goal = await tx.goal.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        name: body.name,
        metric: body.metric,
        targetMinor: BigInt(body.targetMinor),
        startMonth: monthToDate(body.startMonth),
        endMonth: monthToDate(body.endMonth),
        createdBy: business.userId,
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "goal.created",
      context,
      entityType: "goal",
      entityId: goal.id,
      after: { name: body.name, metric: body.metric, targetMinor: body.targetMinor },
    });
    return withProgress(tx, business.businessId, goal);
  });
};

const list = (business: BusinessContext, query: IListGoalsQuery) =>
  withBusinessScope(business, async (tx) => {
    const goals = await tx.goal.findMany({
      where: { businessId: business.businessId, ...(query.status ? { status: query.status } : {}) },
      orderBy: { id: "desc" },
      take: 100,
    });
    return Promise.all(goals.map((goal) => withProgress(tx, business.businessId, goal)));
  });

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, goalId: string) => {
  const goal = await tx.goal.findFirst({ where: { id: goalId, businessId } });
  if (!goal) throw new AppError(404, ErrorCode.NOT_FOUND);
  return goal;
};

const getOne = (business: BusinessContext, goalId: string) =>
  withBusinessScope(business, async (tx) => withProgress(tx, business.businessId, await findOrThrow(tx, business.businessId, goalId)));

const update = (business: BusinessContext, goalId: string, body: IUpdateGoalBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await findOrThrow(tx, business.businessId, goalId);
    if (before.status !== "ACTIVE") throw new AppError(409, ErrorCode.GOAL_NOT_ACTIVE, { status: before.status });

    const after = await tx.goal.update({
      where: { id: goalId },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.targetMinor ? { targetMinor: BigInt(body.targetMinor) } : {}),
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "goal.updated",
      context,
      entityType: "goal",
      entityId: goalId,
      before: { name: before.name, targetMinor: before.targetMinor, status: before.status },
      after: { name: after.name, targetMinor: after.targetMinor, status: after.status },
    });
    return withProgress(tx, business.businessId, after);
  });

// Runs in the worker after each posting. Only an ACTIVE goal can change, so a repeat run does nothing.
const checkProgress = (actor: EventActor) =>
  withBusinessScope(actor, async (tx) => {
    const goals = await tx.goal.findMany({ where: { businessId: actor.businessId, status: "ACTIVE" } });

    for (const goal of goals) {
      if ((await currentValue(tx, actor.businessId, goal)) < goal.targetMinor) continue;

      const { count } = await tx.goal.updateMany({
        where: { id: goal.id, status: "ACTIVE" },
        data: { status: "ACHIEVED", achievedAt: new Date() },
      });
      if (count > 0) await publishEvent(tx, actor, EventType.GOAL_ACHIEVED, { goalId: goal.id });
    }
  });

export const goalsService = { create, list, getOne, update, checkProgress };
