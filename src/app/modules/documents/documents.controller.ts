import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { ICreateUploadBody, IDocumentParams, IListDocumentsQuery } from "./documents.interface.js";
import { documentsService } from "./documents.service.js";

const createUpload: RequestHandler = async (req, res) => {
  sendResponse(res, 201, await documentsService.createUpload(req.business!, req.validated.body as ICreateUploadBody));
};

const completeUpload: RequestHandler = async (req, res) => {
  const { documentId } = req.validated.params as IDocumentParams;
  sendResponse(res, 200, await documentsService.completeUpload(req.business!, documentId, getRequestContext(req)));
};

const list: RequestHandler = async (req, res) => {
  const page = await documentsService.list(req.business!, req.validated.query as IListDocumentsQuery);
  sendResponse(res, 200, page.items, { nextCursor: page.nextCursor });
};

const getDownloadUrl: RequestHandler = async (req, res) => {
  const { documentId } = req.validated.params as IDocumentParams;
  sendResponse(res, 200, await documentsService.getDownloadUrl(req.business!, documentId));
};

const remove: RequestHandler = async (req, res) => {
  const { documentId } = req.validated.params as IDocumentParams;
  await documentsService.remove(req.business!, documentId, getRequestContext(req));
  sendResponse(res, 200, { deleted: true });
};

export const documentsController = { createUpload, completeUpload, list, getDownloadUrl, remove };
