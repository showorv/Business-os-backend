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

// "I've sent the money": how, and the transaction ID the bKash, Nagad, Rocket or bank message gave.
const claim = checkout.extend({
  method: z.enum(["bkash", "nagad", "rocket", "bank"]),
  reference: z
    .string()
    .trim()
    .min(4)
    .max(60)
    .regex(/^[\p{L}\p{N} ._/#-]+$/u, "Letters, digits, spaces and . _ / # - only"),
});

export const billingValidation = { plansQuery, checkout, priceCheck, paymentParams, demoOutcome, claim };
