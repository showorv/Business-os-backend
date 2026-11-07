import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IContactParams, ICreateContactBody, IListContactsQuery, IUpdateContactBody } from "./contacts.interface.js";
import { contactsService } from "./contacts.service.js";

const create: RequestHandler = async (req, res) => {
  const contact = await contactsService.create(req.business!, req.validated.body as ICreateContactBody, getRequestContext(req));
  sendResponse(res, 201, contact);
};

const list: RequestHandler = async (req, res) => {
  const page = await contactsService.list(req.business!, req.validated.query as IListContactsQuery);
  sendResponse(res, 200, page.items, { nextCursor: page.nextCursor });
};

const getOne: RequestHandler = async (req, res) => {
  const { contactId } = req.validated.params as IContactParams;
  sendResponse(res, 200, await contactsService.getOne(req.business!, contactId));
};

const update: RequestHandler = async (req, res) => {
  const { contactId } = req.validated.params as IContactParams;
  const contact = await contactsService.update(req.business!, contactId, req.validated.body as IUpdateContactBody, getRequestContext(req));
  sendResponse(res, 200, contact);
};

export const contactsController = { create, list, getOne, update };
