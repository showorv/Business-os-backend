import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { statementRulesController } from "./statement-rules.controller.js";
import { statementRulesValidation } from "./statement-rules.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = statementRulesValidation.ruleParams;

router.post("/", canWrite, validate({ body: statementRulesValidation.create }), statementRulesController.create);
router.get("/", canRead, statementRulesController.list);
router.patch("/:ruleId", canWrite, validate({ params, body: statementRulesValidation.update }), statementRulesController.update);
router.delete("/:ruleId", canWrite, validate({ params }), statementRulesController.remove);

export const statementRulesRouter = router;
