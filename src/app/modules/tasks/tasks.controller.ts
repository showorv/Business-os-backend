import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  IAllBusinessesTasksQuery,
  IAttachBody,
  IAttachmentParams,
  ICalendarQuery,
  ICommentBody,
  ICreateTaskBody,
  IListTasksQuery,
  ITaskParams,
  IUpdateTaskBody,
} from "./tasks.interface.js";
import { tasksService } from "./tasks.service.js";

const create: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await tasksService.create(req.business!, req.validated.body as ICreateTaskBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await tasksService.list(req.business!, req.validated.query as IListTasksQuery));
};

const listAllBusinesses: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await tasksService.listAllBusinesses(req.auth!, req.validated.query as IAllBusinessesTasksQuery));
};

const summary: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await tasksService.summary(req.business!));
};

const calendar: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await tasksService.calendar(req.business!, req.validated.query as ICalendarQuery));
};

const getOne: RequestHandler = async (req, res) => {
  const { taskId } = req.validated.params as ITaskParams;
  sendResponse(res, 200, await tasksService.getOne(req.business!, taskId));
};

const update: RequestHandler = async (req, res) => {
  const { taskId } = req.validated.params as ITaskParams;
  sendResponse(res, 200, await tasksService.update(req.business!, taskId, req.validated.body as IUpdateTaskBody, getRequestContext(req)));
};

const listComments: RequestHandler = async (req, res) => {
  const { taskId } = req.validated.params as ITaskParams;
  sendResponse(res, 200, await tasksService.listComments(req.business!, taskId));
};

const addComment: RequestHandler = async (req, res) => {
  const { taskId } = req.validated.params as ITaskParams;
  sendResponse(res, 201, await tasksService.addComment(req.business!, taskId, req.validated.body as ICommentBody, getRequestContext(req)));
};

const attach: RequestHandler = async (req, res) => {
  const { taskId } = req.validated.params as ITaskParams;
  const { documentId } = req.validated.body as IAttachBody;
  sendResponse(res, 200, await tasksService.attachDocument(req.business!, taskId, documentId, getRequestContext(req)));
};

const detach: RequestHandler = async (req, res) => {
  const { taskId, documentId } = req.validated.params as IAttachmentParams;
  sendResponse(res, 200, await tasksService.detachDocument(req.business!, taskId, documentId, getRequestContext(req)));
};

export const tasksController = {
  create,
  list,
  listAllBusinesses,
  summary,
  calendar,
  getOne,
  update,
  listComments,
  addComment,
  attach,
  detach,
};
