import type { RequestHandler } from "express";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICompareQuery, IDashboardQuery } from "./analytics.interface.js";
import { analyticsService } from "./analytics.service.js";

const dashboard: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await analyticsService.dashboard(req.business!, req.validated.query as IDashboardQuery));
};

const compare: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await analyticsService.compare(req.business!, req.validated.query as ICompareQuery));
};

export const analyticsController = { dashboard, compare };
