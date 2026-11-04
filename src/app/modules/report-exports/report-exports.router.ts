import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { requireRecentMfa } from "../../middlewares/auth.js";
import { businessRead } from "../../middlewares/businessContext.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { validate } from "../../middlewares/validate.js";
import { reportExportsController } from "./report-exports.controller.js";
import { reportExportsValidation } from "./report-exports.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const params = reportExportsValidation.exportParams;

// A file of financial data can leave the system, so exporting is sensitive and needs recent MFA.
router.post(
  "/",
  canRead,
  requireRecentMfa,
  rateLimit({ name: "report-export", windowSeconds: 3600, max: 60, by: "user" }),
  validate({ body: reportExportsValidation.create }),
  reportExportsController.request,
);
router.get("/", canRead, validate({ query: reportExportsValidation.listQuery }), reportExportsController.list);
router.get("/:exportId", canRead, validate({ params }), reportExportsController.getOne);
router.get("/:exportId/download", canRead, requireRecentMfa, validate({ params }), reportExportsController.download);

export const reportExportsRouter = router;
