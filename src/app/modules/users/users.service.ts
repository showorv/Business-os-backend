import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { ICreateUserInput, IPublicUser, IUpdateMeBody } from "./users.interface.js";

const publicFields = {
  id: true,
  email: true,
  name: true,
  status: true,
  mfaEnabled: true,
  locale: true,
  digitStyle: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

const toPublicUser = (user: IPublicUser): IPublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  status: user.status,
  mfaEnabled: user.mfaEnabled,
  locale: user.locale,
  digitStyle: user.digitStyle,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
});

// Every new user gets their own workspace. That is the tenant boundary for all later data.
const createWithWorkspace = async (tx: Prisma.TransactionClient, input: ICreateUserInput) => {
  const workspace = await tx.workspace.create({ data: { name: input.name } });
  const user = await tx.user.create({
    data: { ...input, workspaces: { create: { workspaceId: workspace.id, isDefault: true } } },
  });
  return { user, workspaceId: workspace.id };
};

const findByEmail = (email: string) =>
  prisma.user.findUnique({ where: { email }, include: { workspaces: true } });

const findById = (id: string) => prisma.user.findUnique({ where: { id }, include: { workspaces: true } });

const findPublicByIds = (ids: string[]) =>
  prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });

// Someone invited into another owner's business also joins that workspace, without it becoming their default.
const addToWorkspace = (tx: Prisma.TransactionClient, userId: string, workspaceId: string) =>
  tx.userWorkspace.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    create: { userId, workspaceId, isDefault: false },
    update: {},
  });

const defaultWorkspaceId = (user: { workspaces: { workspaceId: string; isDefault: boolean }[] }) => {
  const workspace = user.workspaces.find((item) => item.isDefault) ?? user.workspaces[0];
  if (!workspace) throw new Error("user has no workspace");
  return workspace.workspaceId;
};

const recordLogin = (tx: Prisma.TransactionClient, userId: string) =>
  tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });

const setMfaEnabled = (tx: Prisma.TransactionClient, userId: string, mfaEnabled: boolean) =>
  tx.user.update({ where: { id: userId }, data: { mfaEnabled } });

// Invalidates every access token the user currently holds.
const bumpTokenVersion = (tx: Prisma.TransactionClient, userId: string) =>
  tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });

const setPasswordHash = (tx: Prisma.TransactionClient, userId: string, passwordHash: string) =>
  tx.user.update({ where: { id: userId }, data: { passwordHash } });

const getMe = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: publicFields });
  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND);
  return user;
};

const updateMe = async (userId: string, workspaceId: string, body: IUpdateMeBody, context: RequestContext) =>
  prisma.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: publicFields });
    const after = await tx.user.update({ where: { id: userId }, data: body, select: publicFields });

    const changed = Object.keys(body) as (keyof IUpdateMeBody)[];
    await auditService.record(tx, {
      action: "user.updated",
      context,
      workspaceId,
      actorUserId: userId,
      entityType: "user",
      entityId: userId,
      before: Object.fromEntries(changed.map((key) => [key, before[key]])),
      after: Object.fromEntries(changed.map((key) => [key, after[key]])),
    });
    return after;
  });

export const usersService = {
  toPublicUser,
  createWithWorkspace,
  findByEmail,
  findById,
  findPublicByIds,
  addToWorkspace,
  defaultWorkspaceId,
  recordLogin,
  setMfaEnabled,
  bumpTokenVersion,
  setPasswordHash,
  getMe,
  updateMe,
};
