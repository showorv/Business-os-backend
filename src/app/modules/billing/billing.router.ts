import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { billingController } from "./billing.controller.js";
import { billingValidation } from "./billing.validation.js";

const router = Router();

// Public: the pricing page shows these before anyone signs up.
router.get("/plans", validate({ query: billingValidation.plansQuery }), billingController.plans);
router.get("/me", requireAuth, billingController.mine);

router.post("/checkout", requireAuth, validate({ body: billingValidation.checkout }), billingController.checkout);
router.get("/payments", requireAuth, billingController.listPayments);
router.get("/payments/:paymentId", requireAuth, validate({ params: billingValidation.paymentParams }), billingController.getPayment);
// The demo payment page's answer. Real gateways get their own routes, checked with their signature.
router.post(
  "/payments/:paymentId/demo",
  requireAuth,
  validate({ params: billingValidation.paymentParams, body: billingValidation.demoOutcome }),
  billingController.completeDemo,
);

export const billingRouter = router;
