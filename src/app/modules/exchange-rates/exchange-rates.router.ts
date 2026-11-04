import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { exchangeRatesController } from "./exchange-rates.controller.js";
import { exchangeRatesValidation } from "./exchange-rates.validation.js";

const router = Router();

router.post("/", requireAuth, validate({ body: exchangeRatesValidation.save }), exchangeRatesController.save);
router.get("/", requireAuth, validate({ query: exchangeRatesValidation.listQuery }), exchangeRatesController.list);

export const exchangeRatesRouter = router;
