import type { RequestHandler } from "express";
import { readIdempotencyKey } from "../../utils/idempotency.js";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  ISetContactBody,
  IAttachBody,
  IAttachmentParams,
  ICreateTransactionBody,
  IListTransactionsQuery,
  IReverseTransactionBody,
  ITransactionParams,
  IUpdateTransactionBody,
} from "./transactions.interface.js";
import { transactionsService } from "./transactions.service.js";

const create: RequestHandler = async (req, res) => {
  const result = await transactionsService.create(
    req.business!,
    req.validated.body as ICreateTransactionBody,
    readIdempotencyKey(req),
    getRequestContext(req),
  );
  if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
  sendResponse(res, result.statusCode, result.body);
};

const list: RequestHandler = async (req, res) => {
  const page = await transactionsService.list(req.business!, req.validated.query as IListTransactionsQuery);
  sendResponse(res, 200, page.items, { nextCursor: page.nextCursor });
};

const getOne: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  sendResponse(res, 200, await transactionsService.getOne(req.business!, transactionId));
};

const update: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  const transaction = await transactionsService.update(
    req.business!,
    transactionId,
    req.validated.body as IUpdateTransactionBody,
    getRequestContext(req),
  );
  sendResponse(res, 200, transaction);
};

const dismissDuplicate: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  sendResponse(res, 200, await transactionsService.dismissDuplicate(req.business!, transactionId, getRequestContext(req)));
};

const setContact: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  const { contactId } = req.validated.body as ISetContactBody;
  sendResponse(res, 200, await transactionsService.setContact(req.business!, transactionId, contactId, getRequestContext(req)));
};

const voidDraft: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  sendResponse(res, 200, await transactionsService.voidDraft(req.business!, transactionId, getRequestContext(req)));
};

const post: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  sendResponse(res, 200, await transactionsService.post(req.business!, transactionId, getRequestContext(req)));
};

const approve: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  sendResponse(res, 200, await transactionsService.approve(req.business!, transactionId, getRequestContext(req)));
};

const reject: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  sendResponse(res, 200, await transactionsService.reject(req.business!, transactionId, getRequestContext(req)));
};

const reverse: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  const transaction = await transactionsService.reverse(
    req.business!,
    transactionId,
    req.validated.body as IReverseTransactionBody,
    getRequestContext(req),
  );
  sendResponse(res, 200, transaction);
};

const attachDocument: RequestHandler = async (req, res) => {
  const { transactionId } = req.validated.params as ITransactionParams;
  const { documentId } = req.validated.body as IAttachBody;
  await transactionsService.attachDocument(req.business!, transactionId, documentId, getRequestContext(req));
  sendResponse(res, 200, { attached: true });
};

const detachDocument: RequestHandler = async (req, res) => {
  const { transactionId, documentId } = req.validated.params as IAttachmentParams;
  await transactionsService.detachDocument(req.business!, transactionId, documentId, getRequestContext(req));
  sendResponse(res, 200, { detached: true });
};

export const transactionsController = {
  create,
  list,
  getOne,
  update,
  dismissDuplicate,
  setContact,
  voidDraft,
  post,
  approve,
  reject,
  reverse,
  attachDocument,
  detachDocument,
};
