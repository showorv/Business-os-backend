import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { requireAuth } from "../../middlewares/auth.js";
import { requireMembership, requirePermission } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { auditController } from "./audit.controller.js";
import { auditValidation } from "./audit.validation.js";

const router = Router();

router.get("/me", requireAuth, validate({ query: auditValidation.listQuery }), auditController.listMine);

// Mounted at /businesses/:businessId/audit
const businessRouter = Router({ mergeParams: true });

businessRouter.get(
  "/",
  requireAuth,
  requireMembership,
  requirePermission(Permission.AUDIT_READ),
  validate({ query: auditValidation.businessListQuery }),
  auditController.listForBusiness,
);

export const auditRouter = router;
export const businessAuditRouter = businessRouter;
