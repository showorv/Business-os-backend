import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { budgetsController } from "./budgets.controller.js";
import { budgetsValidation } from "./budgets.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = budgetsValidation.budgetParams;

router.post("/", canWrite, validate({ body: budgetsValidation.create }), budgetsController.create);
router.get("/", canRead, validate({ query: budgetsValidation.listQuery }), budgetsController.list);
router.get("/:budgetId", canRead, validate({ params }), budgetsController.getOne);
router.patch("/:budgetId", canWrite, validate({ params, body: budgetsValidation.update }), budgetsController.update);
router.post("/:budgetId/lines", canWrite, validate({ params, body: budgetsValidation.line }), budgetsController.setLine);

export const budgetsRouter = router;
