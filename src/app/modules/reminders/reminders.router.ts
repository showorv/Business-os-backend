import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { remindersController } from "./reminders.controller.js";
import { remindersValidation } from "./reminders.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.TASKS_READ);
const canWrite = businessWrite(Permission.TASKS_WRITE);
const params = remindersValidation.reminderParams;

router.post("/", canWrite, validate({ body: remindersValidation.create }), remindersController.create);
router.get("/", canRead, validate({ query: remindersValidation.listQuery }), remindersController.list);
router.get("/:reminderId", canRead, validate({ params }), remindersController.getOne);
router.patch("/:reminderId", canWrite, validate({ params, body: remindersValidation.update }), remindersController.update);

export const remindersRouter = router;
