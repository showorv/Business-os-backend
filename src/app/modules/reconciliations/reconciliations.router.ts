import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { reconciliationsController } from "./reconciliations.controller.js";
import { reconciliationsValidation } from "./reconciliations.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.LEDGER_POST);
const params = reconciliationsValidation.reconciliationParams;

router.post("/", canWrite, validate({ body: reconciliationsValidation.create }), reconciliationsController.create);
router.get("/", canRead, validate({ query: reconciliationsValidation.listQuery }), reconciliationsController.list);
router.get("/:reconciliationId", canRead, validate({ params }), reconciliationsController.getOne);
router.post(
  "/:reconciliationId/lines",
  canWrite,
  validate({ params, body: reconciliationsValidation.matchLines }),
  reconciliationsController.matchLines,
);
router.post("/:reconciliationId/apply-statement-matches", canWrite, validate({ params }), reconciliationsController.applyStatementMatches);
router.delete(
  "/:reconciliationId/lines/:journalLineId",
  canWrite,
  validate({ params: reconciliationsValidation.lineParams }),
  reconciliationsController.unmatchLine,
);
router.post(
  "/:reconciliationId/close",
  canWrite,
  validate({ params, body: reconciliationsValidation.close }),
  reconciliationsController.close,
);

export const reconciliationsRouter = router;
