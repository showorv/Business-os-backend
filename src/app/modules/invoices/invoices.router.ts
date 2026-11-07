import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { validate } from "../../middlewares/validate.js";
import { invoicesController } from "./invoices.controller.js";
import { invoicesValidation } from "./invoices.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.FINANCE_READ);
const canWrite = businessWrite(Permission.FINANCE_WRITE);
const params = invoicesValidation.invoiceParams;

router.post("/", canWrite, validate({ body: invoicesValidation.create }), invoicesController.create);
router.get("/", canRead, validate({ query: invoicesValidation.listQuery }), invoicesController.list);
// Before /:invoiceId, so "aging" isn't read as an id.
router.get("/aging", canRead, validate({ query: invoicesValidation.agingQuery }), invoicesController.aging);
router.get("/:invoiceId", canRead, validate({ params }), invoicesController.getOne);
router.patch("/:invoiceId", canWrite, validate({ params, body: invoicesValidation.update }), invoicesController.update);
router.delete("/:invoiceId", canWrite, validate({ params }), invoicesController.remove);
router.post("/:invoiceId/issue", canWrite, validate({ params }), invoicesController.issue);
router.post("/:invoiceId/void", canWrite, validate({ params, body: invoicesValidation.voidBody }), invoicesController.voidInvoice);
router.post("/:invoiceId/payments", canWrite, validate({ params, body: invoicesValidation.recordPayment }), invoicesController.recordPayment);
router.post(
  "/:invoiceId/payments/:paymentId/void",
  canWrite,
  validate({ params: invoicesValidation.paymentParams }),
  invoicesController.voidPayment,
);
router.get("/:invoiceId/pdf", canRead, validate({ params, query: invoicesValidation.pdfQuery }), invoicesController.pdf);
router.post("/:invoiceId/email", canWrite, validate({ params, body: invoicesValidation.email }), invoicesController.email);

export const invoicesRouter = router;
