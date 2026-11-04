import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { statementTemplatesController } from "./statement-templates.controller.js";
import { statementTemplatesValidation } from "./statement-templates.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = statementTemplatesValidation.templateParams;

router.post("/", canWrite, validate({ body: statementTemplatesValidation.create }), statementTemplatesController.create);
router.get("/", canRead, statementTemplatesController.list);
router.patch("/:templateId", canWrite, validate({ params, body: statementTemplatesValidation.update }), statementTemplatesController.update);
router.delete("/:templateId", canWrite, validate({ params }), statementTemplatesController.remove);

export const statementTemplatesRouter = router;
