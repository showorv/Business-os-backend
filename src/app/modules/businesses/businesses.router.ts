import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { requireAuth } from "../../middlewares/auth.js";
import { requireMembership, requirePermission, requireWritableBusiness } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { businessesController } from "./businesses.controller.js";
import { businessesValidation } from "./businesses.validation.js";

const router = Router();

const isMember = [requireAuth, requireMembership];
const canManage = [...isMember, requirePermission(Permission.BUSINESS_MANAGE)];

router.post("/", requireAuth, validate({ body: businessesValidation.create }), businessesController.create);
router.get("/", requireAuth, validate({ query: businessesValidation.listQuery }), businessesController.listMine);

router.get("/:businessId", isMember, businessesController.getOne);
router.patch(
  "/:businessId",
  canManage,
  requireWritableBusiness,
  validate({ body: businessesValidation.update }),
  businessesController.update,
);
// No requireWritableBusiness here: this is how an inactive or archived business gets reactivated.
router.post(
  "/:businessId/status",
  canManage,
  validate({ body: businessesValidation.changeStatus }),
  businessesController.changeStatus,
);

export const businessesRouter = router;
