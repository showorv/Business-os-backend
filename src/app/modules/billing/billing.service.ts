import { logger } from "../../../lib/logger.js";
import { paymentGateway } from "../../../lib/payments.js";
import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { invalidateBusinessContext } from "../../utils/businessContextCache.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import { NotificationType } from "../notifications/notifications.interface.js";
import { notificationsService } from "../notifications/notifications.service.js";
import type { Entitlements, ICheckoutBody, IDemoOutcomeBody, PaymentOutcome, PlanLimit, PlanState } from "./billing.interface.js";

export const FREE_PLAN = "free";
// New sign-ups try Pro for this long, then fall back to Free unless they pay.
export const TRIAL_PLAN = "pro";
export const TRIAL_DAYS = 14;
// A paid plan keeps working this long after it ends, so a late payment loses nothing.
export const GRACE_DAYS = 7;
const DAY_MS = 86_400_000;
const MB = 1024 * 1024;

type Subscription = Prisma.WorkspaceSubscriptionGetPayload<{ include: { plan: true } }>;

const freePlan = () => prisma.plan.findUniqueOrThrow({ where: { key: FREE_PLAN } });

// The plan a workspace actually has right now, from its subscription and the clock.
const resolve = async (subscription: Subscription | null, now: Date): Promise<Entitlements> => {
  if (!subscription || subscription.planKey === FREE_PLAN) {
    return { plan: subscription?.plan ?? (await freePlan()), state: "free", subscription, graceEndsAt: null };
  }
  const { endsAt, source } = subscription;
  const stateWhileRunning: PlanState = source === "TRIAL" ? "trial" : source === "GRANT" ? "granted" : "active";
  if (!endsAt || now < endsAt) return { plan: subscription.plan, state: stateWhileRunning, subscription, graceEndsAt: null };

  const graceEndsAt = source === "PAID" ? new Date(endsAt.getTime() + GRACE_DAYS * DAY_MS) : null;
  if (graceEndsAt && now < graceEndsAt) return { plan: subscription.plan, state: "grace", subscription, graceEndsAt };
  return { plan: await freePlan(), state: "expired", subscription, graceEndsAt };
};

const entitlements = async (workspaceId: string, now = new Date()) =>
  resolve(await prisma.workspaceSubscription.findUnique({ where: { workspaceId }, include: { plan: true } }), now);

// Every new workspace starts with a Pro trial.
const startTrial = (tx: Prisma.TransactionClient, workspaceId: string, now = new Date()) =>
  tx.workspaceSubscription.create({
    data: { workspaceId, planKey: TRIAL_PLAN, source: "TRIAL", endsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS) },
  });

const limitError = (limit: PlanLimit, max: number, plan: string) => new AppError(403, ErrorCode.PLAN_LIMIT, { limit, max, plan });

// ---- What a workspace is using ----

// Archived businesses don't count: archiving one is how to get under the limit.
const countBusinesses = (db: Prisma.TransactionClient | typeof prisma, workspaceId: string) =>
  db.business.count({ where: { workspaceId, status: { not: "ARCHIVED" } } });

// Each person counts once however many businesses they're in, and so does a pending invitation.
const seatEmails = async (workspaceId: string) => {
  const rows = await prisma.$queryRaw<{ email: string }[]>`
    SELECT u.email::text AS email FROM business_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${workspaceId}::uuid AND m.status = 'ACTIVE'
    UNION
    SELECT i.email::text FROM invitations i
    WHERE i.workspace_id = ${workspaceId}::uuid AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`;
  return new Set(rows.map((row) => row.email.toLowerCase()));
};

const storageBytes = async (workspaceId: string) => {
  const { _sum } = await prisma.document.aggregate({
    where: { workspaceId, deletedAt: null, status: "READY" },
    _sum: { sizeBytes: true },
  });
  return _sum.sizeBytes ?? 0n;
};

// ---- Checks, called before something is added ----

// Call inside the transaction that creates the business. The row lock stops two at once slipping past.
const assertCanAddBusiness = async (tx: Prisma.TransactionClient, workspaceId: string) => {
  const { plan } = await entitlements(workspaceId);
  if (plan.maxBusinesses === null) return;
  await tx.$executeRaw`SELECT 1 FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
  if ((await countBusinesses(tx, workspaceId)) >= plan.maxBusinesses) throw limitError("businesses", plan.maxBusinesses, plan.key);
};

const assertCanAddMember = async (workspaceId: string, email: string) => {
  const { plan } = await entitlements(workspaceId);
  if (plan.maxMembers === null) return;
  const seats = await seatEmails(workspaceId);
  if (seats.has(email.toLowerCase())) return;
  if (seats.size >= plan.maxMembers) throw limitError("members", plan.maxMembers, plan.key);
};

const assertStorageFor = async (workspaceId: string, addBytes: number) => {
  const { plan } = await entitlements(workspaceId);
  if (plan.storageMb === null) return;
  if ((await storageBytes(workspaceId)) + BigInt(addBytes) > BigInt(plan.storageMb) * BigInt(MB)) throw limitError("storage", plan.storageMb, plan.key);
};

// After a plan ends, the oldest businesses up to the limit keep working; the newer ones become read-only.
const lockedBusinessIds = async (workspaceId: string) => {
  const { plan } = await entitlements(workspaceId);
  if (plan.maxBusinesses === null) return new Set<string>();
  const businesses = await prisma.business.findMany({
    where: { workspaceId, status: { not: "ARCHIVED" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return new Set(businesses.slice(plan.maxBusinesses).map((business) => business.id));
};

// Each business's cached context says whether it's locked, so a plan change clears them all.
const invalidateWorkspaceContexts = async (workspaceId: string) => {
  const businesses = await prisma.business.findMany({ where: { workspaceId }, select: { id: true } });
  await Promise.all(businesses.map((business) => invalidateBusinessContext(business.id)));
};

// The AI belongs to the plan of the workspace that owns each business, not to the person asking.
const aiPlans = async (workspaceIds: string[]) => {
  const unique = [...new Set(workspaceIds)];
  const results = await Promise.all(unique.map((workspaceId) => entitlements(workspaceId)));
  return new Map(unique.map((workspaceId, index) => [workspaceId, results[index]!.plan]));
};

// ---- Answers for the app ----

const toPublicPlan = (plan: Entitlements["plan"]) => ({
  key: plan.key,
  name: plan.name,
  nameBn: plan.nameBn,
  description: plan.description,
  descriptionBn: plan.descriptionBn,
  currency: plan.currency,
  priceMonthlyMinor: plan.priceMonthlyMinor,
  priceYearlyMinor: plan.priceYearlyMinor,
  maxBusinesses: plan.maxBusinesses,
  maxMembers: plan.maxMembers,
  storageMb: plan.storageMb,
  aiEnabled: plan.aiEnabled,
  aiDailyTokens: plan.aiDailyTokens,
});

const listPlans = async () => {
  const plans = await prisma.plan.findMany({ where: { isPublic: true }, orderBy: { sortOrder: "asc" } });
  return plans.map(toPublicPlan);
};

const startOfTodayUtc = () => new Date(new Date().toISOString().slice(0, 10));

// The signed-in person's own workspace: its plan, what's used, and whether they may change it.
const mine = async (auth: { userId: string; workspaceId: string }) => {
  const [current, workspace, businesses, seats, storage, tokens] = await Promise.all([
    entitlements(auth.workspaceId),
    prisma.workspace.findUniqueOrThrow({ where: { id: auth.workspaceId }, select: { ownerUserId: true } }),
    countBusinesses(prisma, auth.workspaceId),
    seatEmails(auth.workspaceId),
    storageBytes(auth.workspaceId),
    prisma.aiMessage.aggregate({
      where: { workspaceId: auth.workspaceId, createdAt: { gte: startOfTodayUtc() } },
      _sum: { promptTokens: true, completionTokens: true },
    }),
  ]);
  const subscription = current.subscription;
  return {
    plan: toPublicPlan(current.plan),
    state: current.state,
    // What the subscription is for, even after it lapsed: "your Pro trial ended".
    subscribedPlanKey: subscription?.planKey ?? FREE_PLAN,
    source: subscription?.source ?? "FREE",
    billingCycle: subscription?.billingCycle ?? null,
    endsAt: subscription?.endsAt ?? null,
    graceEndsAt: current.graceEndsAt,
    isOwner: workspace.ownerUserId === auth.userId,
    usage: {
      businesses,
      members: seats.size,
      storageBytes: storage,
      aiTokensToday: (tokens._sum.promptTokens ?? 0) + (tokens._sum.completionTokens ?? 0),
    },
  };
};

// What a business's members need to know about its workspace's plan.
const forBusiness = async (workspaceId: string, businessId: string) => {
  const [{ plan, state }, locked] = await Promise.all([entitlements(workspaceId), lockedBusinessIds(workspaceId)]);
  return { key: plan.key, name: plan.name, state, aiEnabled: plan.aiEnabled, locked: locked.has(businessId) };
};

// ---- Paying for a plan ----

// A checkout left open longer than this can't be paid; the person starts a new one.
const CHECKOUT_MINUTES = 30;
// Reminders before a plan ends, in days. The nearest one not yet sent goes out.
const REMINDER_DAYS = { PAID: [7, 1], TRIAL: [3, 1], GRANT: [7, 1] } as const;

type Auth = { userId: string; workspaceId: string };

// The calendar day in Bangladesh, as the receipt and emails show it.
const dhakaDay = (moment: Date) => new Date(moment.getTime() + 6 * 3_600_000).toISOString().slice(0, 10);

// One month or one year on, keeping the day of the month where it exists (31 Jan + 1 month = 28/29 Feb).
export const addPeriod = (from: Date, cycle: "MONTHLY" | "YEARLY") => {
  const months = cycle === "YEARLY" ? 12 : 1;
  const target = new Date(from);
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
};

const assertOwner = async (auth: Auth) => {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: auth.workspaceId }, select: { ownerUserId: true } });
  if (workspace.ownerUserId !== auth.userId) throw new AppError(403, ErrorCode.BILLING_OWNER_ONLY);
};

// The person leaves for the payment page. The price comes from the plan now, never from the browser.
const checkout = async (auth: Auth, body: ICheckoutBody, context: RequestContext) => {
  await assertOwner(auth);
  const gateway = paymentGateway();
  if (!gateway) throw new AppError(503, ErrorCode.PAYMENT_GATEWAY_UNAVAILABLE);

  const plan = await prisma.plan.findUnique({ where: { key: body.planKey } });
  const amount = plan ? (body.billingCycle === "YEARLY" ? plan.priceYearlyMinor : plan.priceMonthlyMinor) : 0n;
  if (!plan || !plan.isPublic || amount <= 0n) throw new AppError(400, ErrorCode.PLAN_NOT_FOR_SALE, { planKey: body.planKey });

  const current = await entitlements(auth.workspaceId);
  if (current.state === "granted" && current.subscription?.endsAt === null && current.subscription.planKey === plan.key) {
    throw new AppError(409, ErrorCode.BILLING_NOT_NEEDED);
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { name: true, email: true } });
  const payment = await prisma.$transaction(async (tx) => {
    const created = await tx.payment.create({
      data: {
        workspaceId: auth.workspaceId,
        planKey: plan.key,
        billingCycle: body.billingCycle,
        amountMinor: amount,
        currency: plan.currency,
        gateway: gateway.name,
        createdBy: auth.userId,
        expiresAt: new Date(Date.now() + CHECKOUT_MINUTES * 60_000),
      },
    });
    await auditService.record(tx, {
      action: "billing.checkout_started",
      context,
      workspaceId: auth.workspaceId,
      actorUserId: auth.userId,
      entityType: "payment",
      entityId: created.id,
      after: { planKey: plan.key, billingCycle: body.billingCycle, amountMinor: String(amount), gateway: gateway.name },
    });
    return created;
  });

  const { redirectUrl } = await gateway.startCheckout({
    paymentId: payment.id,
    amountMinor: amount,
    currency: plan.currency,
    description: `${plan.name} (${body.billingCycle === "YEARLY" ? "1 year" : "1 month"})`,
    customer: { name: user.name, email: user.email },
  });
  return { paymentId: payment.id, redirectUrl, amountMinor: amount, currency: plan.currency };
};

// When the new period starts: after the time already covered on the same plan, otherwise now.
const periodStartFor = (subscription: { planKey: string; source: string; endsAt: Date | null } | null, planKey: string, now: Date) => {
  if (subscription && subscription.planKey === planKey && subscription.source !== "FREE" && subscription.endsAt && subscription.endsAt > now) {
    return subscription.endsAt;
  }
  return now;
};

// The gateway's answer. Safe to receive twice: a payment already settled the same way is left as it is.
const settle = async (paymentId: string, outcome: PaymentOutcome, context: RequestContext | null, actorUserId: string | null) => {
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { plan: true } });
    if (payment.status !== "PENDING") {
      if (payment.status === outcome.status) return { payment, changed: false };
      throw new AppError(409, ErrorCode.PAYMENT_NOT_PENDING, { status: payment.status });
    }
    if (outcome.status === "PAID" && payment.expiresAt < now) {
      const expired = await tx.payment.update({ where: { id: paymentId }, data: { status: "CANCELLED", failureReason: "expired" } });
      return { payment: { ...expired, plan: payment.plan }, changed: true, expired: true };
    }

    if (outcome.status !== "PAID") {
      const closed = await tx.payment.update({
        where: { id: paymentId },
        data: { status: outcome.status, gatewayRef: outcome.gatewayRef, method: outcome.method, failureReason: outcome.reason ?? null },
      });
      await auditService.record(tx, {
        action: outcome.status === "FAILED" ? "billing.payment_failed" : "billing.payment_cancelled",
        context,
        workspaceId: payment.workspaceId,
        actorUserId,
        entityType: "payment",
        entityId: paymentId,
        after: { status: outcome.status, method: outcome.method ?? null, reason: outcome.reason ?? null },
      });
      return { payment: { ...closed, plan: payment.plan }, changed: true };
    }

    // Paid: the workspace's plan runs for one more period, and a receipt number is given.
    await tx.$executeRaw`SELECT 1 FROM workspaces WHERE id = ${payment.workspaceId}::uuid FOR UPDATE`;
    const subscription = await tx.workspaceSubscription.findUnique({ where: { workspaceId: payment.workspaceId } });
    const periodStart = periodStartFor(subscription, payment.planKey, now);
    const periodEnd = addPeriod(periodStart, payment.billingCycle);
    const [sequence] = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('payment_receipt_seq') AS value`;
    const receiptNumber = `BOS-${now.getUTCFullYear()}-${String(sequence!.value).padStart(6, "0")}`;

    const paid = await tx.payment.update({
      where: { id: paymentId },
      data: { status: "PAID", gatewayRef: outcome.gatewayRef, method: outcome.method, receiptNumber, periodStart, periodEnd, paidAt: now },
    });
    const next = { planKey: payment.planKey, source: "PAID" as const, billingCycle: payment.billingCycle, endsAt: periodEnd, note: null, grantedBy: null };
    await tx.workspaceSubscription.upsert({ where: { workspaceId: payment.workspaceId }, create: { workspaceId: payment.workspaceId, ...next }, update: next });
    await auditService.record(tx, {
      action: "billing.payment_paid",
      context,
      workspaceId: payment.workspaceId,
      actorUserId,
      entityType: "payment",
      entityId: paymentId,
      before: subscription ? { planKey: subscription.planKey, source: subscription.source, endsAt: subscription.endsAt } : null,
      after: { planKey: payment.planKey, source: "PAID", endsAt: periodEnd, receiptNumber, amountMinor: String(payment.amountMinor) },
    });
    return { payment: { ...paid, plan: payment.plan }, changed: true };
  });

  if (result.changed && result.payment.status === "PAID") {
    await invalidateWorkspaceContexts(result.payment.workspaceId);
    await notificationsService.notifySafely([
      {
        type: NotificationType.PAYMENT_RECEIVED,
        userId: result.payment.createdBy,
        workspaceId: result.payment.workspaceId,
        params: {
          planName: result.payment.plan.name,
          amount: String(result.payment.amountMinor),
          currency: result.payment.currency,
          periodEnd: dhakaDay(result.payment.periodEnd!),
          receiptNumber: result.payment.receiptNumber,
          paymentId: result.payment.id,
        },
        entityType: "payment",
        entityId: result.payment.id,
        dedupeKey: `${NotificationType.PAYMENT_RECEIVED}:${result.payment.id}`,
      },
    ]);
  }
  if ("expired" in result && result.expired) throw new AppError(409, ErrorCode.PAYMENT_EXPIRED);
  return result.payment;
};

const toPaymentDto = (
  payment: Prisma.PaymentGetPayload<{ include: { plan: true; workspace: { select: { owner: { select: { name: true; email: true } } } } } }>,
) => ({
  id: payment.id,
  planKey: payment.planKey,
  planName: payment.plan.name,
  planNameBn: payment.plan.nameBn,
  billingCycle: payment.billingCycle,
  amountMinor: payment.amountMinor,
  currency: payment.currency,
  // A checkout nobody finished shows as cancelled once it can no longer be paid.
  status: payment.status === "PENDING" && payment.expiresAt < new Date() ? "CANCELLED" : payment.status,
  gateway: payment.gateway,
  method: payment.method,
  gatewayRef: payment.gatewayRef,
  receiptNumber: payment.receiptNumber,
  periodStart: payment.periodStart,
  periodEnd: payment.periodEnd,
  failureReason: payment.failureReason,
  expiresAt: payment.expiresAt,
  paidAt: payment.paidAt,
  createdAt: payment.createdAt,
  billedTo: payment.workspace.owner ? { name: payment.workspace.owner.name, email: payment.workspace.owner.email } : null,
});

const paymentInclude = { plan: true, workspace: { select: { owner: { select: { name: true, email: true } } } } } as const;

// Only the workspace's own payments; anyone else's look like they don't exist.
const findOwnPayment = async (auth: Auth, paymentId: string) => {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, workspaceId: auth.workspaceId }, include: paymentInclude });
  if (!payment) throw new AppError(404, ErrorCode.NOT_FOUND);
  return payment;
};

const getPayment = async (auth: Auth, paymentId: string) => toPaymentDto(await findOwnPayment(auth, paymentId));

// Payments that went somewhere: paid, failed or cancelled by the person. Unfinished checkouts are left out.
const listPayments = async (auth: Auth) => {
  const payments = await prisma.payment.findMany({
    where: { workspaceId: auth.workspaceId, status: { not: "PENDING" }, OR: [{ failureReason: null }, { failureReason: { not: "expired" } }] },
    include: paymentInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return payments.map(toPaymentDto);
};

// The demo payment page's answer, as a real gateway's callback would be.
const completeDemo = async (auth: Auth, paymentId: string, body: IDemoOutcomeBody, context: RequestContext) => {
  const payment = await findOwnPayment(auth, paymentId);
  if (payment.gateway !== "demo" || paymentGateway()?.name !== "demo") throw new AppError(503, ErrorCode.PAYMENT_GATEWAY_UNAVAILABLE);
  await settle(
    paymentId,
    {
      status: body.outcome,
      method: body.method,
      gatewayRef: body.outcome === "PAID" ? `DEMO-${paymentId.slice(-12).toUpperCase()}` : undefined,
      reason: body.outcome === "FAILED" ? "declined" : body.outcome === "CANCELLED" ? "cancelled" : undefined,
    },
    context,
    auth.userId,
  );
  return getPayment(auth, paymentId);
};

// ---- Reminders, run every morning by the worker ----

// Each reminder's key includes the end date, so a renewed plan gets fresh reminders and none goes twice.
const sendPlanReminders = async (now = new Date()) => {
  const soon = new Date(now.getTime() + 8 * DAY_MS);
  const recently = new Date(now.getTime() - (GRACE_DAYS + 2) * DAY_MS);
  const subscriptions = await prisma.workspaceSubscription.findMany({
    where: { source: { in: ["TRIAL", "PAID", "GRANT"] }, planKey: { not: FREE_PLAN }, endsAt: { gt: recently, lt: soon } },
    include: { plan: true, workspace: { select: { ownerUserId: true } } },
  });

  let sent = 0;
  for (const subscription of subscriptions) {
    const userId = subscription.workspace.ownerUserId;
    const endsAt = subscription.endsAt!;
    if (!userId) continue;
    const base = { userId, workspaceId: subscription.workspaceId, entityType: "workspace_subscription", entityId: subscription.workspaceId };
    const key = (kind: string) => `billing:${kind}:${subscription.workspaceId}:${endsAt.toISOString()}`;
    const source = subscription.source as "TRIAL" | "PAID" | "GRANT";
    const stage = source === "TRIAL" ? "trial" : source === "GRANT" ? "granted" : "paid";

    if (endsAt > now) {
      const days = Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS);
      const threshold = [...REMINDER_DAYS[source]].sort((a, b) => a - b).find((limit) => days <= limit);
      if (threshold === undefined) continue;
      await notificationsService.notifySafely([
        {
          ...base,
          type: NotificationType.PLAN_ENDING,
          params: { stage, days, endsOn: dhakaDay(endsAt), planName: subscription.plan.name },
          dedupeKey: key(`ending-${threshold}`),
        },
      ]);
      sent += 1;
      continue;
    }

    const graceEndsAt = new Date(endsAt.getTime() + GRACE_DAYS * DAY_MS);
    const inGrace = source === "PAID" && now < graceEndsAt;
    await notificationsService.notifySafely([
      {
        ...base,
        type: NotificationType.PLAN_ENDED,
        params: { stage: inGrace ? "grace" : stage, until: inGrace ? dhakaDay(graceEndsAt) : null, planName: subscription.plan.name },
        dedupeKey: key(inGrace ? "grace" : "ended"),
      },
    ]);
    sent += 1;
  }
  logger.debug({ checked: subscriptions.length, sent }, "plan reminders");
  return { checked: subscriptions.length, sent };
};

export const billingService = {
  checkout,
  settle,
  getPayment,
  listPayments,
  completeDemo,
  sendPlanReminders,
  entitlements,
  startTrial,
  countBusinesses,
  assertCanAddBusiness,
  assertCanAddMember,
  assertStorageFor,
  lockedBusinessIds,
  invalidateWorkspaceContexts,
  aiPlans,
  listPlans,
  mine,
  forBusiness,
};
