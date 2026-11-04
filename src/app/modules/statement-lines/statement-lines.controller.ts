import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICategorizeBody, ILineParams, IListLinesQuery, IMatchBody, IRunMatcherBody, ISplitBody, ISummaryQuery } from "./statement-lines.interface.js";
import { statementLinesService } from "./statement-lines.service.js";

const lineIdOf = (params: unknown) => (params as ILineParams).lineId;

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.list(req.business!, req.validated.query as IListLinesQuery));
};

const summary: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.summary(req.business!, req.validated.query as ISummaryQuery));
};

const runMatcher: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.runMatcher(req.business!, req.validated.body as IRunMatcherBody, getRequestContext(req)));
};

const getOne: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.getOne(req.business!, lineIdOf(req.validated.params)));
};

const match: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.match(req.business!, lineIdOf(req.validated.params), req.validated.body as IMatchBody, getRequestContext(req)));
};

const unmatch: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.unmatch(req.business!, lineIdOf(req.validated.params), getRequestContext(req)));
};

const categorize: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.categorize(req.business!, lineIdOf(req.validated.params), req.validated.body as ICategorizeBody, getRequestContext(req)));
};

const split: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.split(req.business!, lineIdOf(req.validated.params), req.validated.body as ISplitBody, getRequestContext(req)));
};

const ignore: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.ignore(req.business!, lineIdOf(req.validated.params), getRequestContext(req)));
};

const restore: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await statementLinesService.restore(req.business!, lineIdOf(req.validated.params), getRequestContext(req)));
};

export const statementLinesController = { list, summary, runMatcher, getOne, match, unmatch, categorize, split, ignore, restore };
