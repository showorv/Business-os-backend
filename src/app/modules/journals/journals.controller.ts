import type { RequestHandler } from "express";
import { readIdempotencyKey } from "../../utils/idempotency.js";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICreateJournalBody, IJournalParams, IListJournalsQuery, IReverseJournalBody } from "./journals.interface.js";
import { journalsService } from "./journals.service.js";

const create: RequestHandler = async (req, res) => {
  const result = await journalsService.createManual(
    req.business!,
    req.validated.body as ICreateJournalBody,
    readIdempotencyKey(req),
    getRequestContext(req),
  );
  if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
  sendResponse(res, result.statusCode, result.body);
};

const list: RequestHandler = async (req, res) => {
  const page = await journalsService.list(req.business!, req.validated.query as IListJournalsQuery);
  sendResponse(res, 200, page.items, { nextCursor: page.nextCursor });
};

const getOne: RequestHandler = async (req, res) => {
  const { journalId } = req.validated.params as IJournalParams;
  sendResponse(res, 200, await journalsService.getOne(req.business!, journalId));
};

const reverse: RequestHandler = async (req, res) => {
  const { journalId } = req.validated.params as IJournalParams;
  const entry = await journalsService.reverseManual(
    req.business!,
    journalId,
    req.validated.body as IReverseJournalBody,
    getRequestContext(req),
  );
  sendResponse(res, 201, entry);
};

export const journalsController = { create, list, getOne, reverse };
