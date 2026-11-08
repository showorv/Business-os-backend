import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IItemParams, ICreateItemBody, IListItemsQuery, IUpdateItemBody } from "./items.interface.js";
import { itemsService } from "./items.service.js";

const create: RequestHandler = async (req, res) => {
  const item = await itemsService.create(req.business!, req.validated.body as ICreateItemBody, getRequestContext(req));
  sendResponse(res, 201, item);
};

const list: RequestHandler = async (req, res) => {
  const page = await itemsService.list(req.business!, req.validated.query as IListItemsQuery);
  sendResponse(res, 200, page.items, { nextCursor: page.nextCursor });
};

const getOne: RequestHandler = async (req, res) => {
  const { itemId } = req.validated.params as IItemParams;
  sendResponse(res, 200, await itemsService.getOne(req.business!, itemId));
};

const update: RequestHandler = async (req, res) => {
  const { itemId } = req.validated.params as IItemParams;
  const item = await itemsService.update(req.business!, itemId, req.validated.body as IUpdateItemBody, getRequestContext(req));
  sendResponse(res, 200, item);
};

export const itemsController = { create, list, getOne, update };
