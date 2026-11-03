import type { RequestHandler } from "express";
import { env } from "../config/env.config.js";
import { CSRF_COOKIE, CSRF_HEADER } from "../utils/cookies.js";
import { safeEqual } from "../utils/crypto.js";
import { AppError, ErrorCode } from "../utils/errors.js";

// For cookie-authenticated routes only (/auth/refresh, /auth/logout). Everything else uses a
// Bearer header, which a browser never attaches on its own.
export const csrfProtection: RequestHandler = (req, _res, next) => {
  const origin = req.get("origin");
  if (origin && !env.CORS_ORIGINS.includes(origin)) {
    return next(new AppError(403, ErrorCode.CSRF_FAILED));
  }

  const cookieToken: unknown = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);
  if (typeof cookieToken !== "string" || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return next(new AppError(403, ErrorCode.CSRF_FAILED));
  }
  next();
};
