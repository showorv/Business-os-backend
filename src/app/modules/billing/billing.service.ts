import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { invalidateBusinessContext } from "../../utils/businessContextCache.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import type { Entitlements, PlanLimit, PlanState } from "./billing.interface.js";

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

export const billingService = {
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
