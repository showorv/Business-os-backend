import { z } from "zod";

const planStates = ["free", "trial", "active", "grace", "expired", "granted"] as const;

const page = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

const workspacesQuery = z.object({
  search: z.string().trim().max(100).optional(),
  state: z.enum(planStates).optional(),
  suspended: z.enum(["true", "false"]).optional(),
  ...page,
});

const workspaceParams = z.object({ workspaceId: z.uuid() });

// What the admin can set by hand. A paid plan only comes from a payment.
const setSubscription = z
  .object({
    planKey: z.string().trim().min(1).max(40),
    source: z.enum(["FREE", "TRIAL", "GRANT"]),
    // Null: no end date (a gift for good). Required for a trial.
    endsAt: z.iso.datetime({ offset: true }).nullable(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((body) => body.source !== "TRIAL" || body.endsAt !== null, { message: "A trial needs an end date", path: ["endsAt"] })
  .refine((body) => body.source !== "FREE" || body.endsAt === null, { message: "Free has no end date", path: ["endsAt"] })
  .refine((body) => body.endsAt === null || new Date(body.endsAt) > new Date(), { message: "The end date must be in the future", path: ["endsAt"] });

const suspend = z.object({ reason: z.string().trim().min(3).max(300) });

const usersQuery = z.object({ search: z.string().trim().max(100).optional(), ...page });

const minor = z.string().regex(/^\d{1,15}$/, "Whole poisha, as digits");
const limit = z.number().int().min(1).max(1_000_000).nullable();

const planFields = {
  name: z.string().trim().min(1).max(60),
  nameBn: z.string().trim().max(60).nullable(),
  description: z.string().trim().max(300).nullable(),
  descriptionBn: z.string().trim().max(300).nullable(),
  priceMonthlyMinor: minor,
  priceYearlyMinor: minor,
  maxBusinesses: limit,
  maxMembers: limit,
  storageMb: limit,
  aiEnabled: z.boolean(),
  aiDailyTokens: z.number().int().min(0).max(100_000_000),
  isPublic: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};

const createPlan = z.object({ key: z.string().regex(/^[a-z0-9-]{2,40}$/, "Lower-case letters, digits and dashes"), ...planFields });
const updatePlan = z.object(planFields).partial().refine((body) => Object.keys(body).length > 0, { message: "Send at least one field" });
const planParams = z.object({ planKey: z.string().regex(/^[a-z0-9-]{2,40}$/) });

const createCoupon = z
  .object({
    code: z.string().trim().regex(/^[A-Za-z0-9-]{3,40}$/, "Letters, digits and dashes"),
    description: z.string().trim().max(200).nullable().optional(),
    percentOff: z.number().int().min(1).max(100).nullable().optional(),
    amountOffMinor: minor.nullable().optional(),
    planKeys: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine((body) => (body.percentOff ?? null) === null !== ((body.amountOffMinor ?? null) === null), {
    message: "Give a percentage or an amount, not both",
    path: ["percentOff"],
  });

const updateCoupon = z
  .object({
    description: z.string().trim().max(200).nullable(),
    active: z.boolean(),
    maxRedemptions: z.number().int().min(1).max(1_000_000).nullable(),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "Send at least one field" });

const couponParams = z.object({ couponId: z.uuid() });

const paymentsQuery = z.object({
  status: z.enum(["PENDING", "PAID", "FAILED", "CANCELLED"]).optional(),
  search: z.string().trim().max(100).optional(),
  ...page,
});

const activityQuery = z.object({ ...page });

export const platformAdminValidation = {
  workspacesQuery,
  workspaceParams,
  setSubscription,
  suspend,
  usersQuery,
  createPlan,
  updatePlan,
  planParams,
  createCoupon,
  updateCoupon,
  couponParams,
  paymentsQuery,
  activityQuery,
};
