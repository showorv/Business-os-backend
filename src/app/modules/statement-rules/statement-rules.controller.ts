import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICreateRuleBody, IRuleParams, IUpdateRuleBody } from "./statement-rules.interface.js";
import { statementRulesService } from "./statement-rules.service.js";

const create: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await statementRulesService.create(req.business!, req.validated.body as ICreateRuleBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementRulesService.list(req.business!));
};

const update: RequestHandler = async (req, res) => {
  const { ruleId } = req.validated.params as IRuleParams;
  sendResponse(res, 200, await statementRulesService.update(req.business!, ruleId, req.validated.body as IUpdateRuleBody, getRequestContext(req)));
};

const remove: RequestHandler = async (req, res) => {
  const { ruleId } = req.validated.params as IRuleParams;
  sendResponse(res, 200, await statementRulesService.remove(req.business!, ruleId, getRequestContext(req)));
};

export const statementRulesController = { create, list, update, remove };
