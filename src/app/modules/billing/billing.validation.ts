import { z } from "zod";

const plansQuery = z.object({});

const checkout = z.object({
  planKey: z.string().trim().min(1).max(40),
  billingCycle: z.enum(["MONTHLY", "YEARLY"]),
  couponCode: z.string().trim().min(1).max(40).optional(),
});

// What a plan would cost with a coupon, before paying.
const priceCheck = checkout.required({ couponCode: true });

const paymentParams = z.object({ paymentId: z.uuid() });

// The demo payment page's answer. A real gateway sends its own, checked with its signature.
const demoOutcome = z.object({
  outcome: z.enum(["PAID", "FAILED", "CANCELLED"]),
  method: z.enum(["bkash", "nagad", "card"]).optional(),
});

export const billingValidation = { plansQuery, checkout, priceCheck, paymentParams, demoOutcome };
