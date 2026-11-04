import { Router } from "express";
import { Permission } from "../../constants/permissions.js";
import { businessRead, businessWrite } from "../../middlewares/businessContext.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { validate } from "../../middlewares/validate.js";
import { documentsController } from "./documents.controller.js";
import { documentsValidation } from "./documents.validation.js";

const router = Router({ mergeParams: true });

const canRead = businessRead(Permission.DOCUMENTS_READ);
const canWrite = businessWrite(Permission.DOCUMENTS_WRITE);
const params = documentsValidation.documentParams;

router.post(
  "/uploads",
  canWrite,
  rateLimit({ name: "document-upload", windowSeconds: 3600, max: 200, by: "user" }),
  validate({ body: documentsValidation.createUpload }),
  documentsController.createUpload,
);
router.post("/:documentId/complete", canWrite, validate({ params }), documentsController.completeUpload);
router.get("/", canRead, validate({ query: documentsValidation.listQuery }), documentsController.list);
router.get("/:documentId/download", canRead, validate({ params }), documentsController.getDownloadUrl);
router.delete("/:documentId", canWrite, validate({ params }), documentsController.remove);

export const documentsRouter = router;
