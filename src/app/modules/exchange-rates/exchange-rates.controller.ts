import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IListRatesQuery, ISaveRateBody } from "./exchange-rates.interface.js";
import { exchangeRatesService } from "./exchange-rates.service.js";

const save: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await exchangeRatesService.save(req.auth!, req.validated.body as ISaveRateBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await exchangeRatesService.list(req.auth!, req.validated.query as IListRatesQuery));
};

export const exchangeRatesController = { save, list };
