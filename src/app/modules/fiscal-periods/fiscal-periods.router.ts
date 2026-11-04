import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { requireRecentMfa } from "../../middlewares/auth.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { fiscalPeriodsController } from "./fiscal-periods.controller.js";
import { fiscalPeriodsValidation } from "./fiscal-periods.validation.js";

const router = Router({ mergeParams: true });

// Closing the books is sensitive, so it also needs recent MFA.
const canClose = [...businessWrite(Permission.PERIOD_CLOSE), requireRecentMfa];

router.get(
  "/",
  businessRead(Permission.FINANCE_READ),
  validate({ query: fiscalPeriodsValidation.listQuery }),
  fiscalPeriodsController.list,
);
router.post(
  "/years",
  businessWrite(Permission.PERIOD_CLOSE),
  validate({ body: fiscalPeriodsValidation.createYear }),
  fiscalPeriodsController.createYear,
);
router.post(
  "/years/:fiscalYear/close",
  canClose,
  validate({ params: fiscalPeriodsValidation.yearParams }),
  fiscalPeriodsController.closeYear,
);
router.post(
  "/:periodId/status",
  canClose,
  validate({ params: fiscalPeriodsValidation.periodParams, body: fiscalPeriodsValidation.changeStatus }),
  fiscalPeriodsController.changeStatus,
);

export const fiscalPeriodsRouter = router;
