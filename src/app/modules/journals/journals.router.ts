import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { journalsController } from "./journals.controller.js";
import { journalsValidation } from "./journals.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const params = journalsValidation.journalParams;

router.post("/", businessWrite(Permission.LEDGER_POST), validate({ body: journalsValidation.create }), journalsController.create);
router.get("/", canRead, validate({ query: journalsValidation.listQuery }), journalsController.list);
router.get("/:journalId", canRead, validate({ params }), journalsController.getOne);
router.post(
  "/:journalId/reverse",
  businessWrite(Permission.LEDGER_REVERSE),
  validate({ params, body: journalsValidation.reverse }),
  journalsController.reverse,
);

export const journalsRouter = router;
