import { z } from "zod";
import { addPath } from "./registry.js";

export const planState = z.enum(["free", "trial", "active", "grace", "expired", "granted"]);

// Limits are null when the plan has none. Prices are in the smallest unit (poisha), as strings.
export const publicPlan = z.object({
  key: z.string(),
  name: z.string(),
  nameBn: z.string().nullable(),
  description: z.string().nullable(),
  descriptionBn: z.string().nullable(),
  currency: z.string(),
  priceMonthlyMinor: z.string(),
  priceYearlyMinor: z.string(),
  maxBusinesses: z.number().nullable(),
  maxMembers: z.number().nullable(),
  storageMb: z.number().nullable(),
  aiEnabled: z.boolean(),
  aiDailyTokens: z.number(),
});

addPath("Billing", { method: "get", path: "/billing/plans", summary: "The plans on offer, for the pricing page. No sign-in needed", response: z.array(publicPlan), secured: false });
addPath("Billing", {
  method: "get",
  path: "/billing/me",
  summary: "My workspace's plan, what it uses, and whether I may change it",
  response: z.object({
    plan: publicPlan,
    state: planState,
    subscribedPlanKey: z.string(),
    source: z.enum(["FREE", "TRIAL", "PAID", "GRANT"]),
    billingCycle: z.enum(["MONTHLY", "YEARLY"]).nullable(),
    endsAt: z.string().nullable(),
    graceEndsAt: z.string().nullable(),
    isOwner: z.boolean(),
    usage: z.object({ businesses: z.number(), members: z.number(), storageBytes: z.string(), aiTokensToday: z.number() }),
  }),
});
