import { Router } from "express";
import { platformController } from "./platform.controller.js";

const router = Router();

// Public, so the sign-in page can show it too (planned maintenance, for example).
router.get("/announcement", platformController.announcement);
// Public, for the home and pricing pages.
router.get("/signup", platformController.signup);

export const platformRouter = router;
