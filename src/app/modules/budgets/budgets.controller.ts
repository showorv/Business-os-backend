import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IBudgetLineBody, IBudgetParams, ICreateBudgetBody, IListBudgetsQuery, IUpdateBudgetBody } from "./budgets.interface.js";
import { budgetsService } from "./budgets.service.js";

const create: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await budgetsService.create(req.business!, req.validated.body as ICreateBudgetBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await budgetsService.list(req.business!, req.validated.query as IListBudgetsQuery));
};

const getOne: RequestHandler = async (req, res) => {
  const { budgetId } = req.validated.params as IBudgetParams;
  sendResponse(res, 200, await budgetsService.getOne(req.business!, budgetId));
};

const update: RequestHandler = async (req, res) => {
  const { budgetId } = req.validated.params as IBudgetParams;
  sendResponse(res, 200, await budgetsService.update(req.business!, budgetId, req.validated.body as IUpdateBudgetBody, getRequestContext(req)));
};

const setLine: RequestHandler = async (req, res) => {
  const { budgetId } = req.validated.params as IBudgetParams;
  sendResponse(res, 200, await budgetsService.setLine(req.business!, budgetId, req.validated.body as IBudgetLineBody, getRequestContext(req)));
};

export const budgetsController = { create, list, getOne, update, setLine };
