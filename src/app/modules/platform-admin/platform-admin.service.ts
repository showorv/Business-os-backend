import { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../../lib/prisma.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { PlanState } from "../billing/billing.interface.js";
import { billingService, FREE_PLAN, stateOf, whereState } from "../billing/billing.service.js";
import type { IUpdateSettingsBody } from "../platform/platform.interface.js";
import { platformService } from "../platform/platform.service.js";
import type {
  IActivityQuery,
  ICreateCouponBody,
  ICreatePlanBody,
  IPaymentsQuery,
  ISetSubscriptionBody,
  IUpdateCouponBody,
  IUpdatePlanBody,
  IUsersQuery,
  IWorkspacesQuery,
} from "./platform-admin.interface.js";

const STATES: PlanState[] = ["free", "trial", "active", "grace", "expired", "granted"];
const DAY_MS = 86_400_000;

const pageOf = <T>(items: T[], total: number, page: number, pageSize: number) => ({ items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });

// Every admin change goes in the audit log, in the chain of the workspace it touched (or the platform's).
const audit = (
  tx: Prisma.TransactionClient,
  actorUserId: string,
  context: RequestContext,
  entry: { action: string; workspaceId?: string | null; entityType: string; entityId?: string | null; before?: unknown; after?: unknown },
) => auditService.record(tx, { ...entry, action: `platform.${entry.action}`, actorUserId, context });

// ---- Overview ----

const overview = async () => {
  const now = new Date();
  const { graceDays } = await platformService.settings();
  const [workspaces, byState, users, newUsers, suspended, revenue, running] = await Promise.all([
    prisma.workspace.count(),
    Promise.all(STATES.map((state) => prisma.workspace.count({ where: whereState(state, now, graceDays) }))),
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } } }),
    prisma.workspace.count({ where: { suspendedAt: { not: null } } }),
    // Money received per month, in Bangladesh time, for the last 12 months.
    prisma.$queryRaw<{ month: string; amount: bigint; payments: bigint }[]>`
      SELECT to_char(date_trunc('month', paid_at AT TIME ZONE 'Asia/Dhaka'), 'YYYY-MM') AS month,
             sum(amount_minor)::bigint AS amount, count(*)::bigint AS payments
      FROM payments
      WHERE status = 'PAID' AND paid_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') - interval '11 months'
      GROUP BY 1 ORDER BY 1`,
    prisma.workspaceSubscription.findMany({ where: { source: "PAID", endsAt: { gt: now } }, include: { plan: true } }),
  ]);

  // Monthly recurring revenue: each paid plan's price per month, a yearly one as a twelfth.
  const mrr = running.reduce((sum, row) => sum + (row.billingCycle === "YEARLY" ? row.plan.priceYearlyMinor / 12n : row.plan.priceMonthlyMinor), 0n);
  const months = [...Array(12).keys()].map((back) => {
    const day = new Date(now.getTime() + 6 * 3_600_000);
    const date = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - (11 - back), 1));
    const month = date.toISOString().slice(0, 7);
    const row = revenue.find((item) => item.month === month);
    return { month, amountMinor: row?.amount ?? 0n, payments: Number(row?.payments ?? 0) };
  });
  return {
    workspaces: { total: workspaces, suspended, byState: Object.fromEntries(STATES.map((state, index) => [state, byState[index]])) as Record<PlanState, number> },
    users: { total: users, last30Days: newUsers },
    revenue: { currency: "BDT", thisMonthMinor: months.at(-1)!.amountMinor, mrrMinor: mrr, payingWorkspaces: running.length, months },
  };
};

// ---- Workspaces ----

const searchWorkspaces = (search: string | undefined): Prisma.WorkspaceWhereInput =>
  search
    ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { owner: { email: { contains: search, mode: "insensitive" } } },
          { owner: { name: { contains: search, mode: "insensitive" } } },
          { businesses: { some: { name: { contains: search, mode: "insensitive" } } } },
        ],
      }
    : {};

const listWorkspaces = async (query: IWorkspacesQuery) => {
  const now = new Date();
  const { graceDays } = await platformService.settings();
  const where: Prisma.WorkspaceWhereInput = {
    AND: [
      searchWorkspaces(query.search),
      query.state ? whereState(query.state, now, graceDays) : {},
      query.suspended ? { suspendedAt: query.suspended === "true" ? { not: null } : null } : {},
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.workspace.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, email: true } },
        subscription: true,
        _count: { select: { businesses: { where: { status: { not: "ARCHIVED" } } } } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.workspace.count({ where }),
  ]);
  const items = rows.map((row) => ({
    id: row.id,
    name: row.name,
    owner: row.owner,
    planKey: row.subscription?.planKey ?? FREE_PLAN,
    source: row.subscription?.source ?? "FREE",
    state: stateOf(row.subscription, now, graceDays),
    endsAt: row.subscription?.endsAt ?? null,
    businesses: row._count.businesses,
    suspendedAt: row.suspendedAt,
    createdAt: row.createdAt,
  }));
  return pageOf(items, total, query.page, query.pageSize);
};

const findWorkspace = async (workspaceId: string) => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: { owner: { select: { id: true, name: true, email: true, mfaEnabled: true, lastLoginAt: true, createdAt: true } }, subscription: { include: { plan: true } } },
  });
  if (!workspace) throw new AppError(404, ErrorCode.NOT_FOUND);
  return workspace;
};

const getWorkspace = async (workspaceId: string) => {
  const workspace = await findWorkspace(workspaceId);
  const [current, usage, businesses, locked, payments, history] = await Promise.all([
    billingService.entitlements(workspaceId),
    billingService.usageOf(workspaceId),
    prisma.business.findMany({
      where: { workspaceId },
      select: { id: true, name: true, status: true, type: true, createdAt: true, _count: { select: { members: { where: { status: "ACTIVE" } } } } },
      orderBy: { createdAt: "asc" },
    }),
    billingService.lockedBusinessIds(workspaceId),
    prisma.payment.findMany({ where: { workspaceId }, include: billingService.paymentInclude, orderBy: { createdAt: "desc" }, take: 20 }),
    activityRows({ workspaceId, action: { startsWith: "platform." } }, 20),
  ]);
  return {
    id: workspace.id,
    name: workspace.name,
    owner: workspace.owner,
    createdAt: workspace.createdAt,
    suspendedAt: workspace.suspendedAt,
    suspendedReason: workspace.suspendedReason,
    plan: billingService.toPublicPlan(current.plan),
    state: current.state,
    subscription: workspace.subscription
      ? {
          planKey: workspace.subscription.planKey,
          planName: workspace.subscription.plan.name,
          source: workspace.subscription.source,
          billingCycle: workspace.subscription.billingCycle,
          endsAt: workspace.subscription.endsAt,
          note: workspace.subscription.note,
        }
      : null,
    graceEndsAt: current.graceEndsAt,
    usage,
    businesses: businesses.map((business) => ({
      id: business.id,
      name: business.name,
      status: business.status,
      type: business.type,
      members: business._count.members,
      locked: locked.has(business.id),
      createdAt: business.createdAt,
    })),
    payments: payments.map(billingService.toPaymentDto),
    history,
  };
};

// Gives a plan free until a date or for good, extends a trial, or moves the workspace to Free.
const setSubscription = async (actorUserId: string, workspaceId: string, body: ISetSubscriptionBody, context: RequestContext) => {
  await findWorkspace(workspaceId);
  const plan = await prisma.plan.findUnique({ where: { key: body.planKey } });
  if (!plan) throw new AppError(400, ErrorCode.VALIDATION_FAILED, { fields: { planKey: "Unknown plan" } });
  const isFree = plan.key === FREE_PLAN;
  if (isFree !== (body.source === "FREE")) {
    throw new AppError(400, ErrorCode.VALIDATION_FAILED, { fields: { source: isFree ? "Free is set with source FREE" : "Give a paid plan as GRANT or TRIAL" } });
  }
  const data = {
    planKey: plan.key,
    source: body.source,
    billingCycle: null,
    endsAt: body.endsAt ? new Date(body.endsAt) : null,
    note: body.note ?? null,
    grantedBy: body.source === "GRANT" ? actorUserId : null,
  };
  await prisma.$transaction(async (tx) => {
    const before = await tx.workspaceSubscription.findUnique({ where: { workspaceId } });
    await tx.workspaceSubscription.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    await audit(tx, actorUserId, context, {
      action: "subscription_changed",
      workspaceId,
      entityType: "workspace",
      entityId: workspaceId,
      before: before ? { planKey: before.planKey, source: before.source, endsAt: before.endsAt, note: before.note } : null,
      after: { planKey: data.planKey, source: data.source, endsAt: data.endsAt, note: data.note },
    });
  });
  await billingService.invalidateWorkspaceContexts(workspaceId);
  return getWorkspace(workspaceId);
};

const setSuspended = async (actorUserId: string, workspaceId: string, reason: string | null, context: RequestContext) => {
  const workspace = await findWorkspace(workspaceId);
  if ((workspace.suspendedAt !== null) === (reason !== null)) throw new AppError(409, ErrorCode.CONFLICT, { suspended: workspace.suspendedAt !== null });
  // A platform admin's own account can't be locked out by mistake.
  if (reason !== null && workspace.ownerUserId === actorUserId) throw new AppError(409, ErrorCode.CONFLICT, { reason: "own_workspace" });
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspaceId }, data: { suspendedAt: reason ? new Date() : null, suspendedReason: reason } });
    await audit(tx, actorUserId, context, {
      action: reason ? "workspace_suspended" : "workspace_unsuspended",
      workspaceId,
      entityType: "workspace",
      entityId: workspaceId,
      after: { reason },
    });
  });
  await billingService.invalidateWorkspaceContexts(workspaceId);
  return getWorkspace(workspaceId);
};

// ---- Users ----

const listUsers = async (query: IUsersQuery) => {
  const where: Prisma.UserWhereInput = query.search
    ? { OR: [{ email: { contains: query.search, mode: "insensitive" } }, { name: { contains: query.search, mode: "insensitive" } }] }
    : {};
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        mfaEnabled: true,
        isPlatformAdmin: true,
        lastLoginAt: true,
        createdAt: true,
        ownedWorkspaces: { select: { id: true }, take: 1 },
        _count: { select: { memberships: { where: { status: "ACTIVE" } } } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.user.count({ where }),
  ]);
  const items = rows.map(({ ownedWorkspaces, _count, ...user }) => ({ ...user, workspaceId: ownedWorkspaces[0]?.id ?? null, businesses: _count.memberships }));
  return pageOf(items, total, query.page, query.pageSize);
};

// ---- Plans ----

const listPlans = async () => {
  const [plans, counts] = await Promise.all([
    prisma.plan.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.workspaceSubscription.groupBy({ by: ["planKey"], _count: { _all: true } }),
  ]);
  return plans.map((plan) => ({
    ...billingService.toPublicPlan(plan),
    isPublic: plan.isPublic,
    sortOrder: plan.sortOrder,
    workspaces: counts.find((row) => row.planKey === plan.key)?._count._all ?? 0,
  }));
};

// Prices arrive as digit strings (they can be larger than a JavaScript number) and are stored as BigInt.
const planData = ({ priceMonthlyMinor, priceYearlyMinor, ...rest }: IUpdatePlanBody): Prisma.PlanUpdateInput => ({
  ...rest,
  ...(priceMonthlyMinor !== undefined ? { priceMonthlyMinor: BigInt(priceMonthlyMinor) } : {}),
  ...(priceYearlyMinor !== undefined ? { priceYearlyMinor: BigInt(priceYearlyMinor) } : {}),
});

// Free is what everyone falls back to, so it always costs nothing.
const assertFreeStaysFree = (key: string, body: IUpdatePlanBody) => {
  if (key !== FREE_PLAN) return;
  if ((body.priceMonthlyMinor ?? "0") !== "0" || (body.priceYearlyMinor ?? "0") !== "0") {
    throw new AppError(400, ErrorCode.VALIDATION_FAILED, { fields: { priceMonthlyMinor: "The Free plan always costs nothing" } });
  }
};

const createPlan = async (actorUserId: string, body: ICreatePlanBody, context: RequestContext) => {
  assertFreeStaysFree(body.key, body);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.plan.create({ data: { key: body.key, ...planData(body) } as Prisma.PlanCreateInput });
      await audit(tx, actorUserId, context, { action: "plan_created", entityType: "plan", after: body });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new AppError(409, ErrorCode.CONFLICT, { key: body.key });
    throw error;
  }
  return (await listPlans()).find((plan) => plan.key === body.key)!;
};

// A change applies to every workspace on the plan straight away; cached business contexts expire within a minute.
const updatePlan = async (actorUserId: string, key: string, body: IUpdatePlanBody, context: RequestContext) => {
  assertFreeStaysFree(key, body);
  const before = await prisma.plan.findUnique({ where: { key } });
  if (!before) throw new AppError(404, ErrorCode.NOT_FOUND);
  await prisma.$transaction(async (tx) => {
    await tx.plan.update({ where: { key }, data: planData(body) });
    const changed = Object.keys(body) as (keyof IUpdatePlanBody)[];
    await audit(tx, actorUserId, context, {
      action: "plan_updated",
      entityType: "plan",
      before: { key, ...Object.fromEntries(changed.map((field) => [field, String(before[field] ?? "")])) },
      after: { key, ...body },
    });
  });
  return (await listPlans()).find((plan) => plan.key === key)!;
};

// ---- Coupons ----

const listCoupons = () => prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });

const createCoupon = async (actorUserId: string, body: ICreateCouponBody, context: RequestContext) => {
  const plans = await prisma.plan.findMany({ where: { key: { in: body.planKeys } }, select: { key: true } });
  const missing = body.planKeys.filter((key) => !plans.some((plan) => plan.key === key));
  if (missing.length > 0) throw new AppError(400, ErrorCode.VALIDATION_FAILED, { fields: { planKeys: `Unknown plan: ${missing.join(", ")}` } });
  try {
    return await prisma.$transaction(async (tx) => {
      const coupon = await tx.coupon.create({
        data: {
          code: body.code.toUpperCase(),
          description: body.description ?? null,
          percentOff: body.percentOff ?? null,
          amountOffMinor: body.amountOffMinor ? BigInt(body.amountOffMinor) : null,
          planKeys: body.planKeys,
          maxRedemptions: body.maxRedemptions ?? null,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          createdBy: actorUserId,
        },
      });
      await audit(tx, actorUserId, context, { action: "coupon_created", entityType: "coupon", entityId: coupon.id, after: { ...body, code: coupon.code } });
      return coupon;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new AppError(409, ErrorCode.CONFLICT, { code: body.code });
    throw error;
  }
};

const updateCoupon = async (actorUserId: string, couponId: string, body: IUpdateCouponBody, context: RequestContext) => {
  const before = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!before) throw new AppError(404, ErrorCode.NOT_FOUND);
  return prisma.$transaction(async (tx) => {
    const coupon = await tx.coupon.update({
      where: { id: couponId },
      data: { ...body, ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } : {}) },
    });
    await audit(tx, actorUserId, context, {
      action: "coupon_updated",
      entityType: "coupon",
      entityId: couponId,
      before: { active: before.active, maxRedemptions: before.maxRedemptions, expiresAt: before.expiresAt, description: before.description },
      after: body,
    });
    return coupon;
  });
};

// ---- Payments ----

const listPayments = async (query: IPaymentsQuery) => {
  const where: Prisma.PaymentWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { receiptNumber: { contains: query.search, mode: "insensitive" } },
            { couponCode: { contains: query.search, mode: "insensitive" } },
            { workspace: { owner: { email: { contains: query.search, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({ where, include: billingService.paymentInclude, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.payment.count({ where }),
  ]);
  return pageOf(
    rows.map((row) => ({ ...billingService.toPaymentDto(row), workspaceId: row.workspaceId })),
    total,
    query.page,
    query.pageSize,
  );
};

// ---- Settings ----

const getSettings = () => platformService.settings();

const updateSettings = async (actorUserId: string, body: IUpdateSettingsBody, context: RequestContext) => {
  if (body.trialPlanKey && !(await prisma.plan.findUnique({ where: { key: body.trialPlanKey } }))) {
    throw new AppError(400, ErrorCode.VALIDATION_FAILED, { fields: { trialPlanKey: "Unknown plan" } });
  }
  await prisma.$transaction(async (tx) => {
    const before = await platformService.update(tx, body, actorUserId);
    const keys = Object.keys(body) as (keyof IUpdateSettingsBody)[];
    await audit(tx, actorUserId, context, {
      action: "settings_updated",
      entityType: "platform_settings",
      before: Object.fromEntries(keys.map((key) => [key, before[key]])),
      after: body,
    });
  });
  platformService.forgetCache();
  return platformService.settings();
};

// ---- What admins did ----

async function activityRows(where: Prisma.AuditLogWhereInput, take: number, skip = 0) {
  const rows = await prisma.auditLog.findMany({ where, orderBy: { id: "desc" }, take, skip });
  const actorIds = [...new Set(rows.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])))];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } });
  return rows.map((row) => ({
    id: String(row.id),
    action: row.action,
    at: row.at,
    actor: actors.find((actor) => actor.id === row.actorUserId) ?? null,
    workspaceId: row.workspaceId,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before,
    after: row.after,
  }));
}

const activity = async (query: IActivityQuery) => {
  const where = { action: { startsWith: "platform." } };
  const [items, total] = await Promise.all([activityRows(where, query.pageSize, (query.page - 1) * query.pageSize), prisma.auditLog.count({ where })]);
  return pageOf(items, total, query.page, query.pageSize);
};

export const platformAdminService = {
  overview,
  listWorkspaces,
  getWorkspace,
  setSubscription,
  setSuspended,
  listUsers,
  listPlans,
  createPlan,
  updatePlan,
  listCoupons,
  createCoupon,
  updateCoupon,
  listPayments,
  getSettings,
  updateSettings,
  activity,
};
