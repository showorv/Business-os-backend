import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const SAFE_ID = /^[\w-]{8,64}$/;

// A client-sent id is kept only if it is safe to write into logs.
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  req.requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
};
