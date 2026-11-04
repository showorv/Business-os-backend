import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { transactionsController } from "./transactions.controller.js";
import { transactionsValidation } from "./transactions.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = transactionsValidation.transactionParams;

router.post("/", canWrite, validate({ body: transactionsValidation.create }), transactionsController.create);
router.get("/", canRead, validate({ query: transactionsValidation.listQuery }), transactionsController.list);
router.get("/:transactionId", canRead, validate({ params }), transactionsController.getOne);
router.patch("/:transactionId", canWrite, validate({ params, body: transactionsValidation.update }), transactionsController.update);
router.post("/:transactionId/void", canWrite, validate({ params }), transactionsController.voidDraft);
router.post("/:transactionId/dismiss-duplicate", canWrite, validate({ params }), transactionsController.dismissDuplicate);
router.post(
  "/:transactionId/attachments",
  canWrite,
  validate({ params, body: transactionsValidation.attach }),
  transactionsController.attachDocument,
);
router.delete(
  "/:transactionId/attachments/:documentId",
  canWrite,
  validate({ params: transactionsValidation.attachmentParams }),
  transactionsController.detachDocument,
);

export const transactionsRouter = router;
