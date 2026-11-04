import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { requireAuth, requireRecentMfa } from "../../middlewares/auth.js";
import { requireMembership, requirePermission, requireWritableBusiness } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { membersController } from "./members.controller.js";
import { membersValidation } from "./members.validation.js";

// mergeParams: :businessId is declared where this router is mounted.
const router = Router({ mergeParams: true });

// Changing who can do what is sensitive, so it also needs recent MFA.
const canManageMembers = [
  requireAuth,
  requireMembership,
  requirePermission(Permission.MEMBERS_MANAGE),
  requireWritableBusiness,
  requireRecentMfa,
];

router.get("/", requireAuth, requireMembership, membersController.list);
router.patch(
  "/:memberId",
  canManageMembers,
  validate({ params: membersValidation.memberParams, body: membersValidation.updateMember }),
  membersController.update,
);
router.delete(
  "/:memberId",
  canManageMembers,
  validate({ params: membersValidation.memberParams }),
  membersController.remove,
);

export const membersRouter = router;
