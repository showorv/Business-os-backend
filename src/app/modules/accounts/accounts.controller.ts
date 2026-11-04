import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IAccountParams, ICreateAccountBody, IListAccountsQuery, IUpdateAccountBody } from "./accounts.interface.js";
import { accountsService } from "./accounts.service.js";

const create: RequestHandler = async (req, res) => {
  const account = await accountsService.create(req.business!, req.validated.body as ICreateAccountBody, getRequestContext(req));
  sendResponse(res, 201, account);
};

const list: RequestHandler = async (req, res) => {
  const page = await accountsService.list(req.business!, req.validated.query as IListAccountsQuery);
  sendResponse(res, 200, page.items, { nextCursor: page.nextCursor });
};

const getOne: RequestHandler = async (req, res) => {
  const { accountId } = req.validated.params as IAccountParams;
  sendResponse(res, 200, await accountsService.getOne(req.business!, accountId));
};

const update: RequestHandler = async (req, res) => {
  const { accountId } = req.validated.params as IAccountParams;
  const account = await accountsService.update(
    req.business!,
    accountId,
    req.validated.body as IUpdateAccountBody,
    getRequestContext(req),
  );
  sendResponse(res, 200, account);
};

export const accountsController = { create, list, getOne, update };
