import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { vatController } from "./vat.controller.js";
import { vatValidation } from "./vat.validation.js";

const router = Router({ mergeParams: true });

router.get("/summary", businessRead(Permission.FINANCE_READ), validate({ query: vatValidation.summaryQuery }), vatController.summary);

export const vatRouter = router;
