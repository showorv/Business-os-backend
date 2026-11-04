import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { OPTIONAL_PERMISSIONS, RoleKey } from "../../constants/permissions.js";
import {
  cacheContext,
  invalidateBusinessContext,
  readCachedContext,
} from "../../utils/businessContextCache.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import { rolesService } from "../roles/roles.service.js";
import { usersService } from "../users/users.service.js";
import type { BusinessContext, IAddMemberInput, IUpdateMemberBody } from "./members.interface.js";

// Runs before any business context exists, so it uses the normal connection rather than withRls.
const resolveContext = async (userId: string, businessId: string): Promise<BusinessContext | null> => {
  const cached = await readCachedContext(businessId, userId);
  if (cached) return cached;

  const member = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId } },
    include: {
      business: { select: { status: true } },
      role: { select: { key: true, permissions: { select: { permissionKey: true } } } },
    },
  });
  if (!member || member.status !== "ACTIVE") return null;

  const context: BusinessContext = {
    userId,
    workspaceId: member.workspaceId,
    businessId,
    businessStatus: member.business.status,
    memberId: member.id,
    roleKey: member.role.key as RoleKey,
    permissions: [...new Set([...member.role.permissions.map((item) => item.permissionKey), ...member.extraPermissions])],
  };
  await cacheContext(context);
  return context;
};

const listMyMemberships = (userId: string) =>
  prisma.businessMember.findMany({
    where: { userId, status: "ACTIVE" },
    select: { businessId: true, role: { select: { key: true } } },
  });

// Used on the transaction that creates the business, before any RLS scope can include it.
const addOwner = async (
  tx: Prisma.TransactionClient,
  input: Omit<IAddMemberInput, "roleId">,
) => {
  const role = await rolesService.getSystemRole(tx, RoleKey.OWNER);
  return tx.businessMember.create({ data: { ...input, roleId: role.id } });
};

// A person removed earlier gets their old row back, because (business, user) is unique.
const addFromInvitation = async (tx: Prisma.TransactionClient, input: IAddMemberInput) => {
  const existing = await tx.businessMember.findUnique({
    where: { businessId_userId: { businessId: input.businessId, userId: input.userId } },
  });
  if (existing?.status === "ACTIVE") throw new AppError(409, ErrorCode.ALREADY_MEMBER);

  return existing
    ? tx.businessMember.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", roleId: input.roleId, extraPermissions: [] },
      })
    : tx.businessMember.create({ data: input });
};

const isActiveMemberByEmail = async (tx: Prisma.TransactionClient, businessId: string, email: string) => {
  const user = await usersService.findByEmail(email);
  if (!user) return false;
  const member = await tx.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId: user.id } },
    select: { status: true },
  });
  return member?.status === "ACTIVE";
};

const list = async (business: BusinessContext) => {
  const members = await withBusinessScope(
    business,
    (tx) =>
      tx.businessMember.findMany({
        where: { businessId: business.businessId, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          userId: true,
          extraPermissions: true,
          createdAt: true,
          role: { select: { key: true } },
        },
      }),
  );

  const users = await usersService.findPublicByIds(members.map((member) => member.userId));
  const usersById = new Map(users.map((user) => [user.id, user]));

  return members.map(({ role, ...member }) => ({
    ...member,
    roleKey: role.key,
    name: usersById.get(member.userId)?.name,
    email: usersById.get(member.userId)?.email,
  }));
};

const assertMayChange = (actorRole: RoleKey, targetRole: string, newRole?: RoleKey) => {
  const touchesOwner = targetRole === RoleKey.OWNER || newRole === RoleKey.OWNER;
  if (touchesOwner && actorRole !== RoleKey.OWNER) {
    throw new AppError(403, ErrorCode.ROLE_NOT_ASSIGNABLE);
  }
};

const assertExtraPermissionsAllowed = (roleKey: RoleKey, extraPermissions: string[]) => {
  const allowed: string[] = OPTIONAL_PERMISSIONS[roleKey] ?? [];
  const refused = extraPermissions.filter((permission) => !allowed.includes(permission));
  if (refused.length > 0) {
    throw new AppError(422, ErrorCode.PERMISSION_NOT_GRANTABLE, { permissions: refused, roleKey });
  }
};

// The row lock stops two owners demoting each other at the same moment and leaving no owner.
const assertAnotherOwnerRemains = async (tx: Prisma.TransactionClient, businessId: string, memberId: string) => {
  await tx.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
  const otherOwners = await tx.businessMember.count({
    where: { businessId, status: "ACTIVE", id: { not: memberId }, role: { key: RoleKey.OWNER } },
  });
  if (otherOwners === 0) throw new AppError(409, ErrorCode.LAST_OWNER);
};

const findMemberOrThrow = async (tx: Prisma.TransactionClient, businessId: string, memberId: string) => {
  const member = await tx.businessMember.findFirst({
    where: { id: memberId, businessId, status: "ACTIVE" },
    include: { role: { select: { key: true } } },
  });
  if (!member) throw new AppError(404, ErrorCode.NOT_FOUND);
  return member;
};

const update = async (
  business: BusinessContext,
  memberId: string,
  body: IUpdateMemberBody,
  context: RequestContext,
) => {
  const updated = await withBusinessScope(
    business,
    async (tx) => {
      const member = await findMemberOrThrow(tx, business.businessId, memberId);
      const currentRole = member.role.key as RoleKey;
      const nextRole = body.roleKey ?? currentRole;
      assertMayChange(business.roleKey, currentRole, nextRole);

      // A new role drops grants from the old one unless the request sets them again.
      const roleChanged = nextRole !== currentRole;
      const extraPermissions = body.extraPermissions ?? (roleChanged ? [] : member.extraPermissions);
      assertExtraPermissionsAllowed(nextRole, extraPermissions);

      if (currentRole === RoleKey.OWNER && roleChanged) {
        await assertAnotherOwnerRemains(tx, business.businessId, memberId);
      }

      const role = await rolesService.getSystemRole(tx, nextRole);
      const result = await tx.businessMember.update({
        where: { id: memberId },
        data: { roleId: role.id, extraPermissions },
      });

      await auditService.recordForBusiness(tx, business, {
        action: "member.updated",
        context,
        entityType: "business_member",
        entityId: memberId,
        before: { roleKey: currentRole, extraPermissions: member.extraPermissions },
        after: { roleKey: nextRole, extraPermissions },
      });
      return { ...result, roleKey: nextRole };
    },
  );

  await invalidateBusinessContext(business.businessId);
  return { id: updated.id, userId: updated.userId, roleKey: updated.roleKey, extraPermissions: updated.extraPermissions };
};

// Soft delete: the audit history still points at this row.
const remove = async (business: BusinessContext, memberId: string, context: RequestContext) => {
  await withBusinessScope(
    business,
    async (tx) => {
      const member = await findMemberOrThrow(tx, business.businessId, memberId);
      assertMayChange(business.roleKey, member.role.key);

      if (member.role.key === RoleKey.OWNER) {
        await assertAnotherOwnerRemains(tx, business.businessId, memberId);
      }

      await tx.businessMember.update({
        where: { id: memberId },
        data: { status: "REMOVED", extraPermissions: [] },
      });
      await auditService.recordForBusiness(tx, business, {
        action: "member.removed",
        context,
        entityType: "business_member",
        entityId: memberId,
        before: { userId: member.userId, roleKey: member.role.key },
      });
    },
  );

  await invalidateBusinessContext(business.businessId);
};

export const membersService = {
  resolveContext,
  listMyMemberships,
  addOwner,
  addFromInvitation,
  isActiveMemberByEmail,
  list,
  update,
  remove,
};
