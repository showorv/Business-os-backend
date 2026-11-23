import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { validate } from "../../middlewares/validate.js";
import { billingController } from "./billing.controller.js";
import { billingValidation } from "./billing.validation.js";

const router = Router();

// Public: the pricing page shows these before anyone signs up.
router.get("/plans", validate({ query: billingValidation.plansQuery }), billingController.plans);
router.get("/me", requireAuth, billingController.mine);

router.post("/price", requireAuth, validate({ body: billingValidation.priceCheck }), billingController.checkPrice);
router.post("/checkout", requireAuth, validate({ body: billingValidation.checkout }), billingController.checkout);
router.get("/payments", requireAuth, billingController.listPayments);
router.get("/payments/:paymentId", requireAuth, validate({ params: billingValidation.paymentParams }), billingController.getPayment);
// Paying by hand: where to send the money, then "I've sent it", which the admin checks.
router.get("/pay-info", requireAuth, billingController.payInfo);
// Each one notifies the admins, so a person can tell us only a few times an hour.
router.post(
  "/claims",
  requireAuth,
  rateLimit({ name: "payment-claim", windowSeconds: 3600, max: 10, by: "user" }),
  validate({ body: billingValidation.claim }),
  billingController.claim,
);
router.post("/payments/:paymentId/cancel", requireAuth, validate({ params: billingValidation.paymentParams }), billingController.cancelClaim);
// The demo payment page's answer. Real gateways get their own routes, checked with their signature.
router.post(
  "/payments/:paymentId/demo",
  requireAuth,
  validate({ params: billingValidation.paymentParams, body: billingValidation.demoOutcome }),
  billingController.completeDemo,
);

export const billingRouter = router;
