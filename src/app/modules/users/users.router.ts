import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { usersController } from "./users.controller.js";
import { usersValidation } from "./users.validation.js";

const router = Router();

router.get("/me", requireAuth, usersController.getMe);
router.patch("/me", requireAuth, validate({ body: usersValidation.updateMe }), usersController.updateMe);

export const usersRouter = router;
