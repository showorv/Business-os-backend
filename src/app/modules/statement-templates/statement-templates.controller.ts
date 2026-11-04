import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICreateTemplateBody, ITemplateParams, IUpdateTemplateBody } from "./statement-templates.interface.js";
import { statementTemplatesService } from "./statement-templates.service.js";

const create: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await statementTemplatesService.create(req.business!, req.validated.body as ICreateTemplateBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementTemplatesService.list(req.business!));
};

const update: RequestHandler = async (req, res) => {
  const { templateId } = req.validated.params as ITemplateParams;
  sendResponse(res, 200, await statementTemplatesService.update(req.business!, templateId, req.validated.body as IUpdateTemplateBody, getRequestContext(req)));
};

const remove: RequestHandler = async (req, res) => {
  const { templateId } = req.validated.params as ITemplateParams;
  sendResponse(res, 200, await statementTemplatesService.remove(req.business!, templateId, getRequestContext(req)));
};

export const statementTemplatesController = { create, list, update, remove };
