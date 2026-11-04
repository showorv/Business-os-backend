import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICreateReminderBody, IListRemindersQuery, IReminderParams, IUpdateReminderBody } from "./reminders.interface.js";
import { remindersService } from "./reminders.service.js";

const create: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await remindersService.create(req.business!, req.validated.body as ICreateReminderBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await remindersService.list(req.business!, req.validated.query as IListRemindersQuery));
};

const getOne: RequestHandler = async (req, res) => {
  const { reminderId } = req.validated.params as IReminderParams;
  sendResponse(res, 200, await remindersService.getOne(req.business!, reminderId));
};

const update: RequestHandler = async (req, res) => {
  const { reminderId } = req.validated.params as IReminderParams;
  sendResponse(res, 200, await remindersService.update(req.business!, reminderId, req.validated.body as IUpdateReminderBody, getRequestContext(req)));
};

export const remindersController = { create, list, getOne, update };
