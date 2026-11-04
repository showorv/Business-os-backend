import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { categoriesController } from "./categories.controller.js";
import { categoriesValidation } from "./categories.validation.js";

const router = Router({ mergeParams: true });

const canWrite = businessWrite(Permission.FINANCE_WRITE);

router.post("/", canWrite, validate({ body: categoriesValidation.create }), categoriesController.create);
router.get(
  "/",
  businessRead(Permission.FINANCE_READ),
  validate({ query: categoriesValidation.listQuery }),
  categoriesController.list,
);
router.patch(
  "/:categoryId",
  canWrite,
  validate({ params: categoriesValidation.categoryParams, body: categoriesValidation.update }),
  categoriesController.update,
);

export const categoriesRouter = router;
