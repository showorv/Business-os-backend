import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  IChangeStatusBody,
  ICreateBusinessBody,
  IListBusinessesQuery,
  IUpdateBusinessBody,
} from "./businesses.interface.js";
import { businessesService } from "./businesses.service.js";

const create: RequestHandler = async (req, res) => {
  const business = await businessesService.create(
    req.auth!,
    req.validated.body as ICreateBusinessBody,
    getRequestContext(req),
  );
  sendResponse(res, 201, business);
};

const listMine: RequestHandler = async (req, res) => {
  const query = req.validated.query as IListBusinessesQuery;
  sendResponse(res, 200, await businessesService.listMine(req.auth!, query));
};

const getOne: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await businessesService.getOne(req.business!));
};

const update: RequestHandler = async (req, res) => {
  const business = await businessesService.update(
    req.business!,
    req.validated.body as IUpdateBusinessBody,
    getRequestContext(req),
  );
  sendResponse(res, 200, business);
};

const changeStatus: RequestHandler = async (req, res) => {
  const { status } = req.validated.body as IChangeStatusBody;
  sendResponse(res, 200, await businessesService.changeStatus(req.business!, status, getRequestContext(req)));
};

export const businessesController = { create, listMine, getOne, update, changeStatus };
