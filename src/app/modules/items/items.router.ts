import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { itemsController } from "./items.controller.js";
import { itemsValidation } from "./items.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = itemsValidation.itemParams;

router.post("/", canWrite, validate({ body: itemsValidation.create }), itemsController.create);
router.get("/", canRead, validate({ query: itemsValidation.listQuery }), itemsController.list);
router.get("/:itemId", canRead, validate({ params }), itemsController.getOne);
router.patch("/:itemId", canWrite, validate({ params, body: itemsValidation.update }), itemsController.update);

export const itemsRouter = router;
