import type { RequestHandler } from "express";
import { sendResponse } from "../../utils/sendResponse.js";
import { rolesService } from "./roles.service.js";

const list: RequestHandler = async (_req, res) => {
  sendResponse(res, 200, await rolesService.listSystemRoles());
};

export const rolesController = { list };
