import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { accountsController } from "./accounts.controller.js";
import { accountsValidation } from "./accounts.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = accountsValidation.accountParams;

router.post("/", canWrite, validate({ body: accountsValidation.create }), accountsController.create);
router.get("/", canRead, validate({ query: accountsValidation.listQuery }), accountsController.list);
router.get("/:accountId", canRead, validate({ params }), accountsController.getOne);
router.patch("/:accountId", canWrite, validate({ params, body: accountsValidation.update }), accountsController.update);

export const accountsRouter = router;
