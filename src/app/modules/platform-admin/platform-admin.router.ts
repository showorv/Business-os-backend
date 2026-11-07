import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { requirePlatformAdmin } from "../../middlewares/platformAdmin.js";
import { validate } from "../../middlewares/validate.js";
import { platformValidation } from "../platform/platform.validation.js";
import { platformAdminController as c } from "./platform-admin.controller.js";
import { platformAdminValidation as v } from "./platform-admin.validation.js";

// The platform admin panel: every route needs a platform admin with two-step verification on.
const router = Router();
router.use(requireAuth, requirePlatformAdmin);

router.get("/overview", c.overview);

router.get("/workspaces", validate({ query: v.workspacesQuery }), c.listWorkspaces);
router.get("/workspaces/:workspaceId", validate({ params: v.workspaceParams }), c.getWorkspace);
router.post("/workspaces/:workspaceId/subscription", validate({ params: v.workspaceParams, body: v.setSubscription }), c.setSubscription);
router.post("/workspaces/:workspaceId/suspend", validate({ params: v.workspaceParams, body: v.suspend }), c.suspend);
router.post("/workspaces/:workspaceId/unsuspend", validate({ params: v.workspaceParams }), c.unsuspend);

router.get("/users", validate({ query: v.usersQuery }), c.listUsers);

router.get("/plans", c.listPlans);
router.post("/plans", validate({ body: v.createPlan }), c.createPlan);
router.patch("/plans/:planKey", validate({ params: v.planParams, body: v.updatePlan }), c.updatePlan);

router.get("/coupons", c.listCoupons);
router.post("/coupons", validate({ body: v.createCoupon }), c.createCoupon);
router.patch("/coupons/:couponId", validate({ params: v.couponParams, body: v.updateCoupon }), c.updateCoupon);

router.get("/payments", validate({ query: v.paymentsQuery }), c.listPayments);

router.get("/settings", c.getSettings);
router.patch("/settings", validate({ body: platformValidation.updateSettings }), c.updateSettings);

router.get("/activity", validate({ query: v.activityQuery }), c.activity);

export const platformAdminRouter = router;
