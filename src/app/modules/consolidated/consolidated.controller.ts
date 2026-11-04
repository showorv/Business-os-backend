import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IConsolidatedQuery, ICreateTransferBody } from "./consolidated.interface.js";
import { consolidatedService } from "./consolidated.service.js";

const dashboard: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await consolidatedService.dashboard(req.auth!, req.validated.query as IConsolidatedQuery));
};

const createTransfer: RequestHandler = async (req, res) => {
  const transfer = await consolidatedService.createTransfer(req.auth!, req.validated.body as ICreateTransferBody, getRequestContext(req));
  sendResponse(res, 201, transfer);
};

const listTransfers: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await consolidatedService.listTransfers(req.auth!));
};

export const consolidatedController = { dashboard, createTransfer, listTransfers };
