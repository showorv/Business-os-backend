import type { RequestHandler } from "express";
import { authService } from "../modules/auth/auth.service.js";
import { AppError, ErrorCode } from "../utils/errors.js";

const RECENT_MFA_SECONDS = 10 * 60;

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, ErrorCode.UNAUTHENTICATED);
  }
  req.auth = await authService.authenticate(header.slice("Bearer ".length));
  next();
};

// Step-up for sensitive actions. Users without MFA pass, because they have nothing to step up with.
export const requireRecentMfa: RequestHandler = (req, _res, next) => {
  const auth = req.auth;
  if (!auth) throw new AppError(401, ErrorCode.UNAUTHENTICATED);

  const isRecent = auth.mfaAt !== undefined && Date.now() / 1000 - auth.mfaAt <= RECENT_MFA_SECONDS;
  if (auth.mfaEnabled && !isRecent) {
    throw new AppError(401, ErrorCode.MFA_REQUIRED);
  }
  next();
};
