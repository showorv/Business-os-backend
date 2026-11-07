import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { billingController } from "./billing.controller.js";
import { billingValidation } from "./billing.validation.js";

const router = Router();

// Public: the pricing page shows these before anyone signs up.
router.get("/plans", validate({ query: billingValidation.plansQuery }), billingController.plans);
router.get("/me", requireAuth, billingController.mine);

export const billingRouter = router;
