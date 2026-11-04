import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { requireAuth } from "../../middlewares/auth.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { tasksController } from "./tasks.controller.js";
import { tasksValidation } from "./tasks.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.TASKS_READ);
const canWrite = businessWrite(Permission.TASKS_WRITE);
const params = tasksValidation.taskParams;

router.post("/", canWrite, validate({ body: tasksValidation.create }), tasksController.create);
router.get("/", canRead, validate({ query: tasksValidation.listQuery }), tasksController.list);
router.get("/summary", canRead, tasksController.summary);
router.get("/calendar", canRead, validate({ query: tasksValidation.calendarQuery }), tasksController.calendar);
router.get("/:taskId", canRead, validate({ params }), tasksController.getOne);
router.patch("/:taskId", canWrite, validate({ params, body: tasksValidation.update }), tasksController.update);
router.get("/:taskId/comments", canRead, validate({ params }), tasksController.listComments);
router.post("/:taskId/comments", canWrite, validate({ params, body: tasksValidation.comment }), tasksController.addComment);
router.post("/:taskId/attachments", canWrite, validate({ params, body: tasksValidation.attach }), tasksController.attach);
router.delete("/:taskId/attachments/:documentId", canWrite, validate({ params: tasksValidation.attachmentParams }), tasksController.detach);

// The view across every business the caller can see.
const allBusinesses = Router();
allBusinesses.get("/", requireAuth, validate({ query: tasksValidation.allBusinessesQuery }), tasksController.listAllBusinesses);

export const tasksRouter = router;
export const allTasksRouter = allBusinesses;
