import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { goalsController } from "./goals.controller.js";
import { goalsValidation } from "./goals.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = goalsValidation.goalParams;

router.post("/", canWrite, validate({ body: goalsValidation.create }), goalsController.create);
router.get("/", canRead, validate({ query: goalsValidation.listQuery }), goalsController.list);
router.get("/:goalId", canRead, validate({ params }), goalsController.getOne);
router.patch("/:goalId", canWrite, validate({ params, body: goalsValidation.update }), goalsController.update);

export const goalsRouter = router;
