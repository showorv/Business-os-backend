import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICheckoutBody, IClaimBody, IDemoOutcomeBody, IPaymentParams, IPriceCheckBody } from "./billing.interface.js";
import { billingService } from "./billing.service.js";

const plans: RequestHandler = async (_req, res) => {
  sendResponse(res, 200, await billingService.listPlans());
};

const mine: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await billingService.mine(req.auth!));
};

const checkout: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await billingService.checkout(req.auth!, req.validated.body as ICheckoutBody, getRequestContext(req)));
};

const checkPrice: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await billingService.checkPrice(req.validated.body as IPriceCheckBody));
};

const listPayments: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await billingService.listPayments(req.auth!));
};

const getPayment: RequestHandler = async (req, res) => {
  const { paymentId } = req.validated.params as IPaymentParams;
  sendResponse(res, 200, await billingService.getPayment(req.auth!, paymentId));
};

const completeDemo: RequestHandler = async (req, res) => {
  const { paymentId } = req.validated.params as IPaymentParams;
  sendResponse(res, 200, await billingService.completeDemo(req.auth!, paymentId, req.validated.body as IDemoOutcomeBody, getRequestContext(req)));
};

const payInfo: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await billingService.payInfo(req.auth!));
};

const claim: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await billingService.claim(req.auth!, req.validated.body as IClaimBody, getRequestContext(req)));
};

const cancelClaim: RequestHandler = async (req, res) => {
  const { paymentId } = req.validated.params as IPaymentParams;
  sendResponse(res, 200, await billingService.cancelClaim(req.auth!, paymentId, getRequestContext(req)));
};

export const billingController = { plans, mine, checkPrice, checkout, listPayments, getPayment, completeDemo, payInfo, claim, cancelClaim };
