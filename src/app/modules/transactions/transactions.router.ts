import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { transactionsController } from "./transactions.controller.js";
import { transactionsValidation } from "./transactions.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const canApprove = businessWrite(Permission.TRANSACTIONS_APPROVE);
const params = transactionsValidation.transactionParams;

router.post("/", canWrite, validate({ body: transactionsValidation.create }), transactionsController.create);
router.get("/", canRead, validate({ query: transactionsValidation.listQuery }), transactionsController.list);
router.get("/:transactionId", canRead, validate({ params }), transactionsController.getOne);
router.patch("/:transactionId", canWrite, validate({ params, body: transactionsValidation.update }), transactionsController.update);
router.post("/:transactionId/void", canWrite, validate({ params }), transactionsController.voidDraft);
router.post("/:transactionId/post", businessWrite(Permission.LEDGER_POST), validate({ params }), transactionsController.post);
router.post("/:transactionId/approve", canApprove, validate({ params }), transactionsController.approve);
router.post("/:transactionId/reject", canApprove, validate({ params }), transactionsController.reject);
router.post(
  "/:transactionId/reverse",
  businessWrite(Permission.LEDGER_REVERSE),
  validate({ params, body: transactionsValidation.reverse }),
  transactionsController.reverse,
);
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
