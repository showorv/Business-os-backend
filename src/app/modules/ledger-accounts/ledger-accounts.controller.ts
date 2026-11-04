import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  ICreateLedgerAccountBody,
  ILedgerAccountParams,
  IListLedgerAccountsQuery,
  IUpdateLedgerAccountBody,
} from "./ledger-accounts.interface.js";
import { ledgerAccountsService } from "./ledger-accounts.service.js";

const create: RequestHandler = async (req, res) => {
  const account = await ledgerAccountsService.create(
    req.business!,
    req.validated.body as ICreateLedgerAccountBody,
    getRequestContext(req),
  );
  sendResponse(res, 201, account);
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await ledgerAccountsService.list(req.business!, req.validated.query as IListLedgerAccountsQuery));
};

const update: RequestHandler = async (req, res) => {
  const { ledgerAccountId } = req.validated.params as ILedgerAccountParams;
  const account = await ledgerAccountsService.update(
    req.business!,
    ledgerAccountId,
    req.validated.body as IUpdateLedgerAccountBody,
    getRequestContext(req),
  );
  sendResponse(res, 200, account);
};

export const ledgerAccountsController = { create, list, update };
