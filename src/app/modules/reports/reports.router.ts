import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { reportsController } from "./reports.controller.js";
import { reportsValidation } from "./reports.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const asOf = validate({ query: reportsValidation.asOfQuery });
const range = validate({ query: reportsValidation.rangeQuery });

router.get("/trial-balance", canRead, asOf, reportsController.trialBalance);
router.get("/profit-and-loss", canRead, range, reportsController.profitAndLoss);
router.get("/balance-sheet", canRead, asOf, reportsController.balanceSheet);
router.get("/cash-flow", canRead, range, reportsController.cashFlow);

export const reportsRouter = router;
