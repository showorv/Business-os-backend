import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { auditController } from "./audit.controller.js";
import { auditValidation } from "./audit.validation.js";

const router = Router();

router.get("/me", requireAuth, validate({ query: auditValidation.listQuery }), auditController.listMine);

export const auditRouter = router;
