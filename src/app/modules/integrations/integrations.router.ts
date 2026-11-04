import express, { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { requireRecentMfa } from "../../middlewares/auth.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { validate } from "../../middlewares/validate.js";
import { integrationsController } from "./integrations.controller.js";
import { integrationsValidation } from "./integrations.validation.js";

const router = Router({ mergeParams: true });

const canManage = businessWrite(Permission.INTEGRATIONS_MANAGE);
const canRead = businessRead(Permission.INTEGRATIONS_MANAGE);
const params = integrationsValidation.connectionParams;

router.get("/providers", canRead, integrationsController.listProviders);
router.post("/connections", canManage, requireRecentMfa, validate({ body: integrationsValidation.create }), integrationsController.create);
router.get("/connections", canRead, integrationsController.list);
router.get("/connections/:connectionId", canRead, validate({ params }), integrationsController.getOne);
router.patch("/connections/:connectionId", canManage, validate({ params, body: integrationsValidation.update }), integrationsController.update);
router.post("/connections/:connectionId/reauthorize", canManage, requireRecentMfa, validate({ params, body: integrationsValidation.reauthorize }), integrationsController.reauthorize);
router.post("/connections/:connectionId/sync", canManage, validate({ params }), integrationsController.syncNow);
router.get("/connections/:connectionId/sync-runs", canRead, validate({ params, query: integrationsValidation.runsQuery }), integrationsController.listRuns);

// Providers call this directly, with their own signature instead of a sign-in. It needs the exact
// bytes they sent to check that signature, so it reads the raw body.
const webhooks = Router();
webhooks.post(
  "/:connectionId",
  rateLimit({ name: "integration-webhook", windowSeconds: 60, max: 120 }),
  express.raw({ type: () => true, limit: "256kb" }),
  integrationsController.receiveWebhook,
);

export const integrationsRouter = router;
export const integrationWebhooksRouter = webhooks;
