import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { statementLinesController } from "./statement-lines.controller.js";
import { statementLinesValidation } from "./statement-lines.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = statementLinesValidation.lineParams;

router.get("/", canRead, validate({ query: statementLinesValidation.listQuery }), statementLinesController.list);
router.get("/summary", canRead, validate({ query: statementLinesValidation.summaryQuery }), statementLinesController.summary);
router.post("/run-matcher", canWrite, validate({ body: statementLinesValidation.runMatcher }), statementLinesController.runMatcher);
router.get("/:lineId", canRead, validate({ params }), statementLinesController.getOne);
router.post("/:lineId/match", canWrite, validate({ params, body: statementLinesValidation.match }), statementLinesController.match);
router.post("/:lineId/unmatch", canWrite, validate({ params }), statementLinesController.unmatch);
router.post("/:lineId/categorize", canWrite, validate({ params, body: statementLinesValidation.categorize }), statementLinesController.categorize);
router.post("/:lineId/split", canWrite, validate({ params, body: statementLinesValidation.split }), statementLinesController.split);
router.post("/:lineId/ignore", canWrite, validate({ params }), statementLinesController.ignore);
router.post("/:lineId/restore", canWrite, validate({ params }), statementLinesController.restore);

export const statementLinesRouter = router;
