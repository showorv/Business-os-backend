import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { statementImportsController } from "./statement-imports.controller.js";
import { statementImportsValidation } from "./statement-imports.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);

router.post("/preview", canWrite, validate({ body: statementImportsValidation.preview }), statementImportsController.preview);
router.post("/", canWrite, validate({ body: statementImportsValidation.create }), statementImportsController.create);
router.get("/", canRead, validate({ query: statementImportsValidation.listQuery }), statementImportsController.list);
router.get("/:importId", canRead, validate({ params: statementImportsValidation.importParams }), statementImportsController.getOne);

export const statementImportsRouter = router;
