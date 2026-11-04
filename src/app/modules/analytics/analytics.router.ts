import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { analyticsController } from "./analytics.controller.js";
import { analyticsValidation } from "./analytics.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);

router.get("/dashboard", canRead, validate({ query: analyticsValidation.dashboardQuery }), analyticsController.dashboard);
router.get("/compare", canRead, validate({ query: analyticsValidation.compareQuery }), analyticsController.compare);

export const analyticsRouter = router;
