import type { Response } from "express";

export const sendResponse = (res: Response, status: number, data: unknown, meta?: Record<string, unknown>) => {
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
};
