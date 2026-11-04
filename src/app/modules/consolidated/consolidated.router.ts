import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { consolidatedController } from "./consolidated.controller.js";
import { consolidatedValidation } from "./consolidated.validation.js";

const router = Router();

router.get("/dashboard", requireAuth, validate({ query: consolidatedValidation.dashboardQuery }), consolidatedController.dashboard);
router.post(
  "/intercompany-transfers",
  requireAuth,
  validate({ body: consolidatedValidation.createTransfer }),
  consolidatedController.createTransfer,
);
router.get("/intercompany-transfers", requireAuth, consolidatedController.listTransfers);

export const consolidatedRouter = router;
