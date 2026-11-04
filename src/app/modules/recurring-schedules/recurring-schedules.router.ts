import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { recurringSchedulesController } from "./recurring-schedules.controller.js";
import { recurringSchedulesValidation } from "./recurring-schedules.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = recurringSchedulesValidation.scheduleParams;

router.post("/", canWrite, validate({ body: recurringSchedulesValidation.create }), recurringSchedulesController.create);
router.get("/", canRead, validate({ query: recurringSchedulesValidation.listQuery }), recurringSchedulesController.list);
router.get("/:scheduleId", canRead, validate({ params }), recurringSchedulesController.getOne);
router.patch("/:scheduleId", canWrite, validate({ params, body: recurringSchedulesValidation.update }), recurringSchedulesController.update);
router.post("/:scheduleId/run", canWrite, validate({ params }), recurringSchedulesController.runDue);

export const recurringSchedulesRouter = router;
