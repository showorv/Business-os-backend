import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICreateGoalBody, IGoalParams, IListGoalsQuery, IUpdateGoalBody } from "./goals.interface.js";
import { goalsService } from "./goals.service.js";

const create: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await goalsService.create(req.business!, req.validated.body as ICreateGoalBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await goalsService.list(req.business!, req.validated.query as IListGoalsQuery));
};

const getOne: RequestHandler = async (req, res) => {
  const { goalId } = req.validated.params as IGoalParams;
  sendResponse(res, 200, await goalsService.getOne(req.business!, goalId));
};

const update: RequestHandler = async (req, res) => {
  const { goalId } = req.validated.params as IGoalParams;
  sendResponse(res, 200, await goalsService.update(req.business!, goalId, req.validated.body as IUpdateGoalBody, getRequestContext(req)));
};

export const goalsController = { create, list, getOne, update };
