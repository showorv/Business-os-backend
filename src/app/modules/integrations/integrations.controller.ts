import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IConnectionParams, ICreateConnectionBody, IReauthorizeBody, IRunsQuery, IUpdateConnectionBody } from "./integrations.interface.js";
import { integrationsService } from "./integrations.service.js";

const connectionIdOf = (params: unknown) => (params as IConnectionParams).connectionId;

const listProviders: RequestHandler = (_req, res) => {
  sendResponse(res, 200, integrationsService.listProviders());
};

const create: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await integrationsService.create(req.business!, req.validated.body as ICreateConnectionBody, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await integrationsService.list(req.business!));
};

const getOne: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await integrationsService.getOne(req.business!, connectionIdOf(req.validated.params)));
};

const update: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await integrationsService.update(req.business!, connectionIdOf(req.validated.params), req.validated.body as IUpdateConnectionBody, getRequestContext(req)));
};

const reauthorize: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await integrationsService.reauthorize(req.business!, connectionIdOf(req.validated.params), req.validated.body as IReauthorizeBody, getRequestContext(req)));
};

const syncNow: RequestHandler = async (req, res) => {
  sendResponse(res, 202, await integrationsService.syncNow(req.business!, connectionIdOf(req.validated.params)));
};

const listRuns: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await integrationsService.listRuns(req.business!, connectionIdOf(req.validated.params), req.validated.query as IRunsQuery));
};

const receiveWebhook: RequestHandler = async (req, res) => {
  const { connectionId } = req.params as { connectionId: string };
  const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  await integrationsService.receiveWebhook(connectionId, headers, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.ip);
  sendResponse(res, 200, { received: true });
};

export const integrationsController = { listProviders, create, list, getOne, update, reauthorize, syncNow, listRuns, receiveWebhook };
