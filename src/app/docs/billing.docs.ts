import { z } from "zod";
import { billingValidation } from "../modules/billing/billing.validation.js";
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

// One payment for a plan. Amounts are in poisha, as strings. Paid ones have a receipt number and period.
export const payment = z.object({
  id: z.uuid(),
  planKey: z.string(),
  planName: z.string(),
  planNameBn: z.string().nullable(),
  billingCycle: z.enum(["MONTHLY", "YEARLY"]),
  amountMinor: z.string(),
  listAmountMinor: z.string(),
  discountMinor: z.string(),
  couponCode: z.string().nullable(),
  currency: z.string(),
  status: z.enum(["PENDING", "PAID", "FAILED", "CANCELLED"]),
  gateway: z.string(),
  method: z.string().nullable(),
  gatewayRef: z.string().nullable(),
  receiptNumber: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  failureReason: z.string().nullable(),
  expiresAt: z.string(),
  paidAt: z.string().nullable(),
  createdAt: z.string(),
  billedTo: z.object({ name: z.string(), email: z.string() }).nullable(),
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
    // A payment made by hand that the admin hasn't checked yet.
    pendingPayment: payment.nullable(),
    usage: z.object({ businesses: z.number(), members: z.number(), storageBytes: z.string(), aiTokensToday: z.number() }),
  }),
});


addPath("Billing", {
  method: "post",
  path: "/billing/checkout",
  summary: "Start paying for a plan. Owner only. Returns where to send the person to pay; the price comes from the plan",
  body: billingValidation.checkout,
  status: 201,
  response: z.object({ paymentId: z.uuid(), redirectUrl: z.string(), amountMinor: z.string(), currency: z.string() }),
});
addPath("Billing", {
  method: "post",
  path: "/billing/price",
  summary: "What a plan costs with a coupon, before paying. COUPON_INVALID says why a code can't be used",
  body: billingValidation.priceCheck,
  response: z.object({ planKey: z.string(), billingCycle: z.enum(["MONTHLY", "YEARLY"]), currency: z.string(), listAmountMinor: z.string(), discountMinor: z.string(), amountMinor: z.string(), couponCode: z.string().nullable() }),
});
addPath("Billing", { method: "get", path: "/billing/payments", summary: "My workspace's payments, newest first (unfinished checkouts left out)", response: z.array(payment) });
addPath("Billing", { method: "get", path: "/billing/payments/{paymentId}", summary: "One payment, with what the receipt needs", params: billingValidation.paymentParams, response: payment });
addPath("Billing", {
  method: "post",
  path: "/billing/payments/{paymentId}/demo",
  summary: "The demo payment page's answer: paid, failed or cancelled. Only while the demo gateway is on; no money moves",
  params: billingValidation.paymentParams,
  body: billingValidation.demoOutcome,
  response: payment,
});

const manualMethod = z.enum(["bkash", "nagad", "rocket", "bank"]);
addPath("Billing", {
  method: "get",
  path: "/billing/pay-info",
  summary: "How to pay: online, and/or by hand (bKash, Nagad, Rocket, bank) with the numbers to send to and a reference code. manual is null when paying by hand is off",
  response: z.object({
    online: z.boolean(),
    manual: z
      .object({
        methods: z.array(z.object({ method: manualMethod, details: z.string() })),
        whatsapp: z.string(),
        phone: z.string(),
        email: z.string(),
        noteEn: z.string(),
        noteBn: z.string(),
        reference: z.string(),
        reviewDays: z.number(),
      })
      .nullable(),
  }),
});
addPath("Billing", {
  method: "post",
  path: "/billing/claims",
  summary: "\"I've sent the money\": the method and transaction ID. Owner only, one waiting at a time (PAYMENT_CLAIM_OPEN). The admins are told; the plan starts once one approves. The price comes from the plan and any coupon",
  body: billingValidation.claim,
  status: 201,
  response: payment,
});
addPath("Billing", {
  method: "post",
  path: "/billing/payments/{paymentId}/cancel",
  summary: "Take back a payment told by hand that the admin hasn't checked yet",
  params: billingValidation.paymentParams,
  response: payment,
});
