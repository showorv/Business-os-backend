import type { RequestHandler } from "express";
import { securityLogger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { AppError, ErrorCode } from "../utils/errors.js";

// The platform admin panel controls every account and its money, so it needs both the admin flag and
// two-step verification. Checked against the database on every request, so removing the flag takes
// effect at once.
export const requirePlatformAdmin: RequestHandler = async (req, _res, next) => {
  const auth = req.auth;
  if (!auth) throw new AppError(401, ErrorCode.UNAUTHENTICATED);
  const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { isPlatformAdmin: true, mfaEnabled: true } });
  if (!user?.isPlatformAdmin) {
    securityLogger.warn({ user_id: auth.userId, path: req.originalUrl }, "platform admin access denied");
    throw new AppError(403, ErrorCode.PLATFORM_ADMIN_ONLY);
  }
  if (!user.mfaEnabled) throw new AppError(403, ErrorCode.PLATFORM_ADMIN_MFA_REQUIRED);
  next();
};
