import type { RequestHandler } from "express";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IVatSummaryQuery } from "./vat.interface.js";
import { vatService } from "./vat.service.js";

const summary: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await vatService.summary(req.business!, req.validated.query as IVatSummaryQuery));
};

export const vatController = { summary };
