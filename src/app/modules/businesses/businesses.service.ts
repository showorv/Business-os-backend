import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope, withRls } from "../../../lib/rls.js";
import { invalidateBusinessContext } from "../../utils/businessContextCache.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.interface.js";
import type { BusinessContext } from "../members/members.interface.js";
import { membersService } from "../members/members.service.js";
import type {
  IChangeStatusBody,
  ICreateBusinessBody,
  IListBusinessesQuery,
  IUpdateBusinessBody,
} from "./businesses.interface.js";
import { defaultBusinessSettings } from "./businesses.validation.js";

type BusinessStatus = IChangeStatusBody["status"];

const ALLOWED_TRANSITIONS: Record<BusinessStatus, BusinessStatus[]> = {
  ACTIVE: ["INACTIVE", "ARCHIVED"],
  INACTIVE: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: ["ACTIVE"],
};

// One transaction: a business never exists without its owner. Later phases add their setup here
// (Phase 3 categories and the Cash account, Phase 4 chart of accounts and fiscal periods).
// It uses the normal connection because the new id cannot be in an RLS scope before it exists.
const create = (auth: AuthContext, body: ICreateBusinessBody, context: RequestContext) =>
  prisma.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: {
        ...body,
        workspaceId: auth.workspaceId,
        createdBy: auth.userId,
        settings: { ...defaultBusinessSettings, ...body.settings },
      },
    });

    const owner = { workspaceId: auth.workspaceId, businessId: business.id, userId: auth.userId, createdBy: auth.userId };
    await membersService.addOwner(tx, owner);

    await auditService.record(tx, {
      action: "business.created",
      context,
      workspaceId: auth.workspaceId,
      businessId: business.id,
      actorUserId: auth.userId,
      entityType: "business",
      entityId: business.id,
      after: { name: business.name, type: business.type, baseCurrency: business.baseCurrency },
    });
    return business;
  });

// RLS is scoped to the caller's memberships, so this can only ever see their own businesses.
const listMine = async (auth: AuthContext, query: IListBusinessesQuery) => {
  const memberships = await membersService.listMyMemberships(auth.userId);
  const roleByBusiness = new Map(memberships.map((item) => [item.businessId, item.role.key]));
  const businessIds = [...roleByBusiness.keys()];

  const businesses = await withRls({ userId: auth.userId, businessIds }, (tx) =>
    tx.business.findMany({
      where: {
        id: { in: businessIds },
        ...(query.includeArchived ? {} : { status: { not: "ARCHIVED" } }),
      },
      orderBy: { createdAt: "asc" },
    }),
  );

  return businesses.map((business) => ({ ...business, roleKey: roleByBusiness.get(business.id) }));
};

const getOne = async (business: BusinessContext) => {
  const row = await withBusinessScope(business, (tx) =>
    tx.business.findUniqueOrThrow({ where: { id: business.businessId } }),
  );
  return { ...row, membership: { roleKey: business.roleKey, permissions: business.permissions } };
};

const changedFields = (before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]) => {
  const pick = (source: Record<string, unknown>) => Object.fromEntries(keys.map((key) => [key, source[key]]));
  return { before: pick(before), after: pick(after) };
};

const update = (business: BusinessContext, body: IUpdateBusinessBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await tx.business.findUniqueOrThrow({ where: { id: business.businessId } });

    // Phase 4: refuse a baseCurrency change once the business has posted journals.
    const { settings, ...fields } = body;
    const after = await tx.business.update({
      where: { id: business.businessId },
      data: {
        ...fields,
        ...(settings ? { settings: { ...(before.settings as Prisma.JsonObject), ...settings } } : {}),
      },
    });

    await auditService.recordForBusiness(tx, business, {
      action: "business.updated",
      context,
      entityType: "business",
      entityId: business.businessId,
      ...changedFields(before, after, Object.keys(body)),
    });
    return after;
  });

const changeStatus = async (business: BusinessContext, status: BusinessStatus, context: RequestContext) => {
  if (!ALLOWED_TRANSITIONS[business.businessStatus].includes(status)) {
    throw new AppError(409, ErrorCode.INVALID_STATUS_CHANGE, { from: business.businessStatus, to: status });
  }

  const updated = await withBusinessScope(business, async (tx) => {
    const result = await tx.business.update({ where: { id: business.businessId }, data: { status } });
    await auditService.recordForBusiness(tx, business, {
      action: "business.status_changed",
      context,
      entityType: "business",
      entityId: business.businessId,
      before: { status: business.businessStatus },
      after: { status },
    });
    return result;
  });

  await invalidateBusinessContext(business.businessId);
  return updated;
};

export const businessesService = { create, listMine, getOne, update, changeStatus };
