import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { invalidateBusinessContext } from "../../utils/businessContextCache.js";
import { encryptSecret, randomToken, sha256Hex } from "../../utils/crypto.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.interface.js";
import type { BusinessContext } from "../members/members.interface.js";
import { membersService } from "../members/members.service.js";
import { rolesService } from "../roles/roles.service.js";
import { usersService } from "../users/users.service.js";
import type { ICreateInvitationBody } from "./invitations.interface.js";

const EXPIRY_DAYS = 7;

// Only the hash is stored, so the token is returned here once, in case the inviter wants to share it
// by hand. The email carries it encrypted through the outbox, so it is never readable in the database.
const create = async (business: BusinessContext, body: ICreateInvitationBody, context: RequestContext) => {
  const token = randomToken();

  const invitation = await withBusinessScope(business, async (tx) => {
    if (await membersService.isActiveMemberByEmail(tx, business.businessId, body.email)) {
      throw new AppError(409, ErrorCode.ALREADY_MEMBER);
    }

    // Inviting the same email again replaces the old invitation.
    await tx.invitation.updateMany({
      where: { businessId: business.businessId, email: body.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const role = await rolesService.getSystemRole(tx, body.roleKey);
    const created = await tx.invitation.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        email: body.email,
        roleId: role.id,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000),
        createdBy: business.userId,
      },
    });

    await auditService.recordForBusiness(tx, business, {
      action: "invitation.created",
      context,
      entityType: "invitation",
      entityId: created.id,
      after: { email: body.email, roleKey: body.roleKey },
    });
    await publishEvent(tx, business, EventType.INVITATION_CREATED, {
      invitationId: created.id,
      tokenEncrypted: encryptSecret(token, created.id),
    });
    return created;
  });

  return {
    id: invitation.id,
    email: invitation.email,
    roleKey: body.roleKey,
    expiresAt: invitation.expiresAt,
    token,
  };
};

const listPending = async (business: BusinessContext) => {
  const invitations = await withBusinessScope(business, (tx) =>
    tx.invitation.findMany({
      where: {
        businessId: business.businessId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, expiresAt: true, createdAt: true, role: { select: { key: true } } },
    }),
  );
  return invitations.map(({ role, ...invitation }) => ({ ...invitation, roleKey: role.key }));
};

const revoke = (business: BusinessContext, invitationId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const { count } = await tx.invitation.updateMany({
      where: { id: invitationId, businessId: business.businessId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new AppError(404, ErrorCode.NOT_FOUND);

    await auditService.recordForBusiness(tx, business, {
      action: "invitation.revoked",
      context,
      entityType: "invitation",
      entityId: invitationId,
    });
  });

// Uses the normal connection: the caller is not a member yet, so no RLS scope can include them.
// The token proves the invitation was received, and the email must also match the account.
const accept = async (auth: AuthContext, token: string, context: RequestContext) => {
  const user = await usersService.findById(auth.userId);
  if (!user) throw new AppError(401, ErrorCode.TOKEN_INVALID);
  const tokenHash = sha256Hex(token);

  const member = await prisma.$transaction(async (tx) => {
    // The row lock makes two simultaneous accepts of one token run one after the other.
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM invitations WHERE token_hash = ${tokenHash} FOR UPDATE`;
    if (!locked) throw new AppError(404, ErrorCode.INVITATION_INVALID);

    const invitation = await tx.invitation.findUniqueOrThrow({
      where: { id: locked.id },
      include: { business: { select: { status: true } } },
    });
    if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
      throw new AppError(404, ErrorCode.INVITATION_INVALID);
    }
    if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new AppError(403, ErrorCode.INVITATION_EMAIL_MISMATCH);
    }
    if (invitation.business.status !== "ACTIVE") {
      throw new AppError(409, ErrorCode.BUSINESS_NOT_ACTIVE, { status: invitation.business.status });
    }

    const added = await membersService.addFromInvitation(tx, {
      workspaceId: invitation.workspaceId,
      businessId: invitation.businessId,
      userId: user.id,
      roleId: invitation.roleId,
      createdBy: invitation.createdBy,
    });
    await usersService.addToWorkspace(tx, user.id, invitation.workspaceId);
    await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });

    await auditService.record(tx, {
      action: "invitation.accepted",
      context,
      workspaceId: invitation.workspaceId,
      businessId: invitation.businessId,
      actorUserId: user.id,
      entityType: "business_member",
      entityId: added.id,
    });
    return added;
  });

  await invalidateBusinessContext(member.businessId);
  return { businessId: member.businessId, memberId: member.id };
};

export const invitationsService = { create, listPending, revoke, accept };
