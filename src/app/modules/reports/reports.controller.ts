import type { RequestHandler } from "express";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IAsOfQuery, IRangeQuery } from "./reports.interface.js";
import { reportsService } from "./reports.service.js";

const trialBalance: RequestHandler = async (req, res) => {
  const { asOf } = req.validated.query as IAsOfQuery;
  sendResponse(res, 200, await reportsService.trialBalance(req.business!, asOf));
};

const profitAndLoss: RequestHandler = async (req, res) => {
  const { from, to } = req.validated.query as IRangeQuery;
  sendResponse(res, 200, await reportsService.profitAndLoss(req.business!, from, to));
};

const balanceSheet: RequestHandler = async (req, res) => {
  const { asOf } = req.validated.query as IAsOfQuery;
  sendResponse(res, 200, await reportsService.balanceSheet(req.business!, asOf));
};

const cashFlow: RequestHandler = async (req, res) => {
  const { from, to } = req.validated.query as IRangeQuery;
  sendResponse(res, 200, await reportsService.cashFlow(req.business!, from, to));
};

export const reportsController = { trialBalance, profitAndLoss, balanceSheet, cashFlow };
