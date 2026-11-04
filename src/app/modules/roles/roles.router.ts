import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { rolesController } from "./roles.controller.js";

const router = Router();

router.get("/", requireAuth, rolesController.list);

export const rolesRouter = router;
