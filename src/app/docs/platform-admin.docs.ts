import { z } from "zod";
import { platformValidation } from "../modules/platform/platform.validation.js";
import { platformAdminValidation as v } from "../modules/platform-admin/platform-admin.validation.js";
import { payment, planState, publicPlan } from "./billing.docs.js";
import { addPath } from "./registry.js";

const paged = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number(), page: z.number(), pageSize: z.number(), pages: z.number() });
const person = z.object({ id: z.uuid(), name: z.string(), email: z.string() });
const source = z.enum(["FREE", "TRIAL", "PAID", "GRANT"]);

const settings = z.object({
  trialDays: z.number(),
  trialPlanKey: z.string(),
  graceDays: z.number(),
  aiEnabled: z.boolean(),
  signupsEnabled: z.boolean(),
  announcement: z.object({ active: z.boolean(), tone: z.enum(["info", "warning"]), en: z.string(), bn: z.string() }),
});

const workspaceRow = z.object({
  id: z.uuid(),
  name: z.string(),
  owner: person.nullable(),
  planKey: z.string(),
  source,
  state: planState,
  endsAt: z.string().nullable(),
  businesses: z.number(),
  suspendedAt: z.string().nullable(),
  createdAt: z.string(),
});

const activityRow = z.object({
  id: z.string(),
  action: z.string(),
  at: z.string(),
  actor: person.nullable(),
  workspaceId: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
});

const workspaceDetail = z.object({
  id: z.uuid(),
  name: z.string(),
  owner: z.object({ id: z.uuid(), name: z.string(), email: z.string(), mfaEnabled: z.boolean(), lastLoginAt: z.string().nullable(), createdAt: z.string() }).nullable(),
  createdAt: z.string(),
  suspendedAt: z.string().nullable(),
  suspendedReason: z.string().nullable(),
  plan: publicPlan,
  state: planState,
  subscription: z
    .object({ planKey: z.string(), planName: z.string(), source, billingCycle: z.enum(["MONTHLY", "YEARLY"]).nullable(), endsAt: z.string().nullable(), note: z.string().nullable() })
    .nullable(),
  graceEndsAt: z.string().nullable(),
  usage: z.object({ businesses: z.number(), members: z.number(), storageBytes: z.string(), aiTokensToday: z.number() }),
  businesses: z.array(z.object({ id: z.uuid(), name: z.string(), status: z.string(), type: z.string(), members: z.number(), locked: z.boolean(), createdAt: z.string() })),
  payments: z.array(payment),
  history: z.array(activityRow),
});

const adminPlan = publicPlan.extend({ isPublic: z.boolean(), sortOrder: z.number(), workspaces: z.number() });

const coupon = z.object({
  id: z.uuid(),
  code: z.string(),
  description: z.string().nullable(),
  percentOff: z.number().nullable(),
  amountOffMinor: z.string().nullable(),
  planKeys: z.array(z.string()),
  maxRedemptions: z.number().nullable(),
  redemptions: z.number(),
  expiresAt: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
});

const T = "Platform admin";
addPath("Platform", {
  method: "get",
  path: "/platform/announcement",
  summary: "The message shown at the top of the app, or null. No sign-in needed",
  response: z.object({ tone: z.enum(["info", "warning"]), en: z.string(), bn: z.string() }).nullable(),
  secured: false,
});

addPath(T, {
  method: "get",
  path: "/admin/overview",
  summary: "Accounts by plan state, people, and money received. Platform admins with two-step verification only, like every /admin route",
  response: z.object({
    workspaces: z.object({ total: z.number(), suspended: z.number(), byState: z.record(planState, z.number()) }),
    users: z.object({ total: z.number(), last30Days: z.number() }),
    revenue: z.object({
      currency: z.string(),
      thisMonthMinor: z.string(),
      mrrMinor: z.string(),
      payingWorkspaces: z.number(),
      months: z.array(z.object({ month: z.string(), amountMinor: z.string(), payments: z.number() })),
    }),
  }),
});
addPath(T, { method: "get", path: "/admin/workspaces", summary: "Accounts, newest first. Search by owner, account or business name; filter by plan state", query: v.workspacesQuery, response: paged(workspaceRow) });
addPath(T, { method: "get", path: "/admin/workspaces/{workspaceId}", summary: "One account: plan, usage, businesses, payments and what admins changed", params: v.workspaceParams, response: workspaceDetail });
addPath(T, {
  method: "post",
  path: "/admin/workspaces/{workspaceId}/subscription",
  summary: "Give a plan free (GRANT) until a date or for good, set a trial, or move to Free",
  params: v.workspaceParams,
  body: v.setSubscription,
  response: workspaceDetail,
});
addPath(T, { method: "post", path: "/admin/workspaces/{workspaceId}/suspend", summary: "Suspend an account: nobody can open its businesses. Nothing is deleted", params: v.workspaceParams, body: v.suspend, response: workspaceDetail });
addPath(T, { method: "post", path: "/admin/workspaces/{workspaceId}/unsuspend", summary: "Lift a suspension", params: v.workspaceParams, response: workspaceDetail });
addPath(T, {
  method: "get",
  path: "/admin/users",
  summary: "Everyone with an account, newest first",
  query: v.usersQuery,
  response: paged(
    z.object({
      id: z.uuid(),
      name: z.string(),
      email: z.string(),
      status: z.string(),
      mfaEnabled: z.boolean(),
      isPlatformAdmin: z.boolean(),
      lastLoginAt: z.string().nullable(),
      createdAt: z.string(),
      workspaceId: z.string().nullable(),
      businesses: z.number(),
    }),
  ),
});
addPath(T, { method: "get", path: "/admin/plans", summary: "Every plan, hidden ones too, with how many accounts use each", response: z.array(adminPlan) });
addPath(T, { method: "post", path: "/admin/plans", summary: "Add a plan", body: v.createPlan, status: 201, response: adminPlan });
addPath(T, { method: "patch", path: "/admin/plans/{planKey}", summary: "Change a plan's prices, limits or AI. Applies to every account on it", params: v.planParams, body: v.updatePlan, response: adminPlan });
addPath(T, { method: "get", path: "/admin/coupons", summary: "Coupons, newest first", response: z.array(coupon) });
addPath(T, { method: "post", path: "/admin/coupons", summary: "Make a coupon: a percentage or an amount off", body: v.createCoupon, status: 201, response: coupon });
addPath(T, { method: "patch", path: "/admin/coupons/{couponId}", summary: "Switch a coupon off or on, or change its limits", params: v.couponParams, body: v.updateCoupon, response: coupon });
addPath(T, { method: "get", path: "/admin/payments", summary: "Every payment, newest first", query: v.paymentsQuery, response: paged(payment.extend({ workspaceId: z.uuid() })) });
addPath(T, { method: "get", path: "/admin/settings", summary: "Trial, grace days, AI switch, sign-ups and the announcement", response: settings });
addPath(T, { method: "patch", path: "/admin/settings", summary: "Change some of the platform settings", body: platformValidation.updateSettings, response: settings });
addPath(T, { method: "get", path: "/admin/activity", summary: "What platform admins changed, newest first", query: v.activityQuery, response: paged(activityRow) });
