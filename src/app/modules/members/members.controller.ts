import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IMemberParams, IUpdateMemberBody } from "./members.interface.js";
import { membersService } from "./members.service.js";

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await membersService.list(req.business!));
};

const update: RequestHandler = async (req, res) => {
  const { memberId } = req.validated.params as IMemberParams;
  const member = await membersService.update(
    req.business!,
    memberId,
    req.validated.body as IUpdateMemberBody,
    getRequestContext(req),
  );
  sendResponse(res, 200, member);
};

const remove: RequestHandler = async (req, res) => {
  const { memberId } = req.validated.params as IMemberParams;
  await membersService.remove(req.business!, memberId, getRequestContext(req));
  sendResponse(res, 200, { removed: true });
};

export const membersController = { list, update, remove };
