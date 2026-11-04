import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICreateExportBody, IExportParams, IListExportsQuery } from "./report-exports.interface.js";
import { reportExportsService } from "./report-exports.service.js";

const request: RequestHandler = async (req, res) => {
  sendResponse(res, 202, await reportExportsService.request(req.business!, req.validated.body as ICreateExportBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await reportExportsService.list(req.business!, req.validated.query as IListExportsQuery));
};

const getOne: RequestHandler = async (req, res) => {
  const { exportId } = req.validated.params as IExportParams;
  sendResponse(res, 200, await reportExportsService.getOne(req.business!, exportId));
};

const download: RequestHandler = async (req, res) => {
  const { exportId } = req.validated.params as IExportParams;
  sendResponse(res, 200, await reportExportsService.getDownloadUrl(req.business!, exportId));
};

export const reportExportsController = { request, list, getOne, download };
