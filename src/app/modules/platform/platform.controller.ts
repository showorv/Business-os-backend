import type { RequestHandler } from "express";
import { sendResponse } from "../../utils/sendResponse.js";
import { platformService } from "./platform.service.js";

const announcement: RequestHandler = async (_req, res) => {
  sendResponse(res, 200, await platformService.announcement());
};

const signup: RequestHandler = async (_req, res) => {
  sendResponse(res, 200, await platformService.signup());
};

export const platformController = { announcement, signup };
