import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  ICloseReconciliationBody,
  ICreateReconciliationBody,
  IListReconciliationsQuery,
  IMatchLinesBody,
  IReconciliationLineParams,
  IReconciliationParams,
} from "./reconciliations.interface.js";
import { reconciliationsService } from "./reconciliations.service.js";

const create: RequestHandler = async (req, res) => {
  const reconciliation = await reconciliationsService.create(
    req.business!,
    req.validated.body as ICreateReconciliationBody,
    getRequestContext(req),
  );
  sendResponse(res, 201, reconciliation);
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await reconciliationsService.list(req.business!, req.validated.query as IListReconciliationsQuery));
};

const getOne: RequestHandler = async (req, res) => {
  const { reconciliationId } = req.validated.params as IReconciliationParams;
  sendResponse(res, 200, await reconciliationsService.getOne(req.business!, reconciliationId));
};

const matchLines: RequestHandler = async (req, res) => {
  const { reconciliationId } = req.validated.params as IReconciliationParams;
  const { journalLineIds } = req.validated.body as IMatchLinesBody;
  sendResponse(res, 200, await reconciliationsService.matchLines(req.business!, reconciliationId, journalLineIds));
};

const unmatchLine: RequestHandler = async (req, res) => {
  const { reconciliationId, journalLineId } = req.validated.params as IReconciliationLineParams;
  await reconciliationsService.unmatchLine(req.business!, reconciliationId, journalLineId);
  sendResponse(res, 200, { unmatched: true });
};

const close: RequestHandler = async (req, res) => {
  const { reconciliationId } = req.validated.params as IReconciliationParams;
  const { adjust } = req.validated.body as ICloseReconciliationBody;
  sendResponse(res, 200, await reconciliationsService.close(req.business!, reconciliationId, adjust, getRequestContext(req)));
};

const applyStatementMatches: RequestHandler = async (req, res) => {
  const { reconciliationId } = req.validated.params as IReconciliationParams;
  sendResponse(res, 200, await reconciliationsService.applyStatementMatches(req.business!, reconciliationId));
};

export const reconciliationsController = {
  applyStatementMatches, create, list, getOne, matchLines, unmatchLine, close };
