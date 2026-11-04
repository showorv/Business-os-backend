import type { RequestHandler } from "express";
import { z } from "zod";
import { securityLogger } from "../../lib/logger.js";
import { requireAuth } from "./auth.js";
import type { Permission } from "../constants/permissions.js";
import { auditService } from "../modules/audit/audit.service.js";
import { membersService } from "../modules/members/members.service.js";
import { AppError, ErrorCode } from "../utils/errors.js";
import { getRequestContext } from "../utils/requestContext.js";

const businessIdSchema = z.uuid();

// Puts the caller's role and permissions on req.business. Answers 404, not 403, for a business the
// caller is not in, so nobody can discover which business ids exist.
export const requireMembership: RequestHandler = async (req, _res, next) => {
  const auth = req.auth;
  if (!auth) throw new AppError(401, ErrorCode.UNAUTHENTICATED);

  const parsedId = businessIdSchema.safeParse(req.params.businessId);
  if (!parsedId.success) throw new AppError(404, ErrorCode.NOT_FOUND);

  const business = await membersService.resolveContext(auth.userId, parsedId.data);
  if (!business) {
    securityLogger.warn({ user_id: auth.userId, business_id: parsedId.data }, "business access denied");
    await auditService.recordStandalone({
      action: "business.access_denied",
      context: getRequestContext(req),
      actorUserId: auth.userId,
      entityType: "business",
      entityId: parsedId.data,
    });
    throw new AppError(404, ErrorCode.NOT_FOUND);
  }

  req.business = business;
  next();
};

export const requirePermission = (permission: Permission): RequestHandler => {
  return async (req, _res, next) => {
    const business = req.business;
    if (!business) throw new AppError(404, ErrorCode.NOT_FOUND);

    if (!business.permissions.includes(permission)) {
      await auditService.recordStandalone({
        action: "permission.denied",
        context: getRequestContext(req),
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        actorUserId: business.userId,
        entityType: "business",
        entityId: business.businessId,
        after: { permission, route: req.route?.path },
      });
      throw new AppError(403, ErrorCode.PERMISSION_DENIED, { permission });
    }
    next();
  };
};

// Inactive and archived businesses stay readable, but nothing in them may change.
export const requireWritableBusiness: RequestHandler = (req, _res, next) => {
  if (req.business?.businessStatus !== "ACTIVE") {
    throw new AppError(409, ErrorCode.BUSINESS_NOT_ACTIVE, { status: req.business?.businessStatus });
  }
  next();
};

// The two guard chains most business routes need.
export const businessRead = (permission: Permission) => [requireAuth, requireMembership, requirePermission(permission)];
export const businessWrite = (permission: Permission) => [...businessRead(permission), requireWritableBusiness];
