import type { RequestHandler } from "express";
import { sendResponse } from "../../utils/sendResponse.js";
import { billingService } from "./billing.service.js";

const plans: RequestHandler = async (_req, res) => {
  sendResponse(res, 200, await billingService.listPlans());
};

const mine: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await billingService.mine(req.auth!));
};

export const billingController = { plans, mine };
