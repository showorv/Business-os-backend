import * as Sentry from "@sentry/node";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { logger } from "../../lib/logger.js";
import { AppError, ErrorCode } from "../utils/errors.js";

export const notFound: RequestHandler = () => {
  throw new AppError(404, ErrorCode.NOT_FOUND);
};

const BODY_PARSER_ERRORS: Record<string, [number, ErrorCode]> = {
  "entity.parse.failed": [400, ErrorCode.INVALID_JSON],
  "entity.too.large": [413, ErrorCode.PAYLOAD_TOO_LARGE],
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  let status = 500;
  let code: ErrorCode = ErrorCode.INTERNAL_ERROR;
  let params: Record<string, unknown> | undefined;

  const bodyParserError = BODY_PARSER_ERRORS[(error as { type?: string }).type ?? ""];

  if (error instanceof AppError) {
    ({ status, code, params } = error);
  } else if (bodyParserError) {
    [status, code] = bodyParserError;
  } else {
    // Unknown failures keep their detail in the logs and in Sentry, never in the response.
    logger.error({ err: error, request_id: req.requestId }, "unhandled error");
    Sentry.captureException(error, { tags: { request_id: req.requestId } });
  }

  if (typeof params?.retryAfterSeconds === "number") {
    res.setHeader("Retry-After", params.retryAfterSeconds);
  }

  res.status(status).json({
    success: false,
    error: { code, ...(params ? { params } : {}), requestId: req.requestId },
  });
};
