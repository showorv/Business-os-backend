import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { contactsController } from "./contacts.controller.js";
import { contactsValidation } from "./contacts.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = contactsValidation.contactParams;

router.post("/", canWrite, validate({ body: contactsValidation.create }), contactsController.create);
router.get("/", canRead, validate({ query: contactsValidation.listQuery }), contactsController.list);
router.get("/:contactId", canRead, validate({ params }), contactsController.getOne);
router.patch("/:contactId", canWrite, validate({ params, body: contactsValidation.update }), contactsController.update);

export const contactsRouter = router;
