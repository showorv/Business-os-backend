import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { ledgerAccountsController } from "./ledger-accounts.controller.js";
import { ledgerAccountsValidation } from "./ledger-accounts.validation.js";

const router = Router({ mergeParams: true });

const canWrite = businessWrite(Permission.LEDGER_POST);

router.post("/", canWrite, validate({ body: ledgerAccountsValidation.create }), ledgerAccountsController.create);
router.get(
  "/",
  businessRead(Permission.FINANCE_READ),
  validate({ query: ledgerAccountsValidation.listQuery }),
  ledgerAccountsController.list,
);
router.patch(
  "/:ledgerAccountId",
  canWrite,
  validate({ params: ledgerAccountsValidation.ledgerAccountParams, body: ledgerAccountsValidation.update }),
  ledgerAccountsController.update,
);

export const ledgerAccountsRouter = router;
