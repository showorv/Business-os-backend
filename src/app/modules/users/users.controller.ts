import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IUpdateMeBody } from "./users.interface.js";
import { usersService } from "./users.service.js";

const getMe: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await usersService.getMe(req.auth!.userId));
};

const updateMe: RequestHandler = async (req, res) => {
  const { userId, workspaceId } = req.auth!;
  const user = await usersService.updateMe(
    userId,
    workspaceId,
    req.validated.body as IUpdateMeBody,
    getRequestContext(req),
  );
  sendResponse(res, 200, user);
};

export const usersController = { getMe, updateMe };
