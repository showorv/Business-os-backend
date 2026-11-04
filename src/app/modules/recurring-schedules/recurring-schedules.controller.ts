import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICreateScheduleBody, IListSchedulesQuery, IScheduleParams, IUpdateScheduleBody } from "./recurring-schedules.interface.js";
import { recurringSchedulesService } from "./recurring-schedules.service.js";

const create: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await recurringSchedulesService.create(req.business!, req.validated.body as ICreateScheduleBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await recurringSchedulesService.list(req.business!, req.validated.query as IListSchedulesQuery));
};

const getOne: RequestHandler = async (req, res) => {
  const { scheduleId } = req.validated.params as IScheduleParams;
  sendResponse(res, 200, await recurringSchedulesService.getOne(req.business!, scheduleId));
};

const update: RequestHandler = async (req, res) => {
  const { scheduleId } = req.validated.params as IScheduleParams;
  sendResponse(res, 200, await recurringSchedulesService.update(req.business!, scheduleId, req.validated.body as IUpdateScheduleBody, getRequestContext(req)));
};

const runDue: RequestHandler = async (req, res) => {
  const { scheduleId } = req.validated.params as IScheduleParams;
  sendResponse(res, 200, await recurringSchedulesService.runDueForRequest(req.business!, scheduleId));
};

export const recurringSchedulesController = { create, list, getOne, update, runDue };
