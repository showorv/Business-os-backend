import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { journalsService } from "../journals/journals.service.js";
import type {
  IChangePeriodStatusBody,
  ICreateYearBody,
  IListPeriodsQuery,
  IPeriodParams,
  IYearParams,
} from "./fiscal-periods.interface.js";
import { fiscalPeriodsService } from "./fiscal-periods.service.js";

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await fiscalPeriodsService.list(req.business!, req.validated.query as IListPeriodsQuery));
};

const createYear: RequestHandler = async (req, res) => {
  const { fiscalYear } = req.validated.body as ICreateYearBody;
  sendResponse(res, 201, await fiscalPeriodsService.createYear(req.business!, fiscalYear, getRequestContext(req)));
};

const changeStatus: RequestHandler = async (req, res) => {
  const { periodId } = req.validated.params as IPeriodParams;
  const { status } = req.validated.body as IChangePeriodStatusBody;
  sendResponse(res, 200, await fiscalPeriodsService.changeStatus(req.business!, periodId, status, getRequestContext(req)));
};

const closeYear: RequestHandler = async (req, res) => {
  const { fiscalYear } = req.validated.params as IYearParams;
  sendResponse(res, 200, await journalsService.closeYear(req.business!, fiscalYear, getRequestContext(req)));
};

export const fiscalPeriodsController = { list, createYear, changeStatus, closeYear };
