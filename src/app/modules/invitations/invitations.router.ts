import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { requireAuth } from "../../middlewares/auth.js";
import { requireMembership, requirePermission, requireWritableBusiness } from "../../middlewares/businessContext.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { validate } from "../../middlewares/validate.js";
import { invitationsController } from "./invitations.controller.js";
import { invitationsValidation } from "./invitations.validation.js";

// Mounted at /businesses/:businessId/invitations
const businessRouter = Router({ mergeParams: true });

const canReadInvitations = [requireAuth, requireMembership, requirePermission(Permission.MEMBERS_MANAGE)];
const canChangeInvitations = [...canReadInvitations, requireWritableBusiness];

businessRouter.get("/", canReadInvitations, invitationsController.list);
businessRouter.post(
  "/",
  canChangeInvitations,
  rateLimit({ name: "invitation-create", windowSeconds: 3600, max: 30, by: "user" }),
  validate({ body: invitationsValidation.create }),
  invitationsController.create,
);
businessRouter.delete(
  "/:invitationId",
  canChangeInvitations,
  validate({ params: invitationsValidation.invitationParams }),
  invitationsController.revoke,
);

// Mounted at /invitations: the caller is not a member of the business yet.
const publicRouter = Router();

publicRouter.post(
  "/accept",
  requireAuth,
  rateLimit({ name: "invitation-accept", windowSeconds: 60, max: 10, by: "user" }),
  validate({ body: invitationsValidation.accept }),
  invitationsController.accept,
);

export const businessInvitationsRouter = businessRouter;
export const invitationsRouter = publicRouter;
