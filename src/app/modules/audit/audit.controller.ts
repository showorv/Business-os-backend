import type { RequestHandler } from "express";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IListAuditQuery } from "./audit.interface.js";
import { auditService } from "./audit.service.js";

const listMine: RequestHandler = async (req, res) => {
  const result = await auditService.listForActor(req.auth!.userId, req.validated.query as IListAuditQuery);
  sendResponse(res, 200, result.items, { nextCursor: result.nextCursor });
};

export const auditController = { listMine };
