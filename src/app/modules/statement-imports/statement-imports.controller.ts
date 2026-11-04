import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICreateImportBody, IImportParams, IListImportsQuery, IPreviewBody } from "./statement-imports.interface.js";
import { statementImportsService } from "./statement-imports.service.js";

const preview: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementImportsService.preview(req.business!, req.validated.body as IPreviewBody));
};

const create: RequestHandler = async (req, res) => {
  sendResponse(res, 202, await statementImportsService.request(req.business!, req.validated.body as ICreateImportBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementImportsService.list(req.business!, req.validated.query as IListImportsQuery));
};

const getOne: RequestHandler = async (req, res) => {
  const { importId } = req.validated.params as IImportParams;
  sendResponse(res, 200, await statementImportsService.getOne(req.business!, importId));
};

export const statementImportsController = { preview, create, list, getOne };
