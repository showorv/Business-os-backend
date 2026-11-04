import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { generateSecret, generateURI, verify as verifyTotpCode } from "otplib";
import { securityLogger } from "../../../lib/logger.js";
import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { env } from "../../config/env.config.js";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "../../utils/crypto.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import {
  accessTokenTtlSeconds,
  signAccessToken,
  signMfaChallenge,
  verifyAccessToken,
  verifyMfaChallenge,
} from "../../utils/jwt.js";
import { assertNotLocked, clearFailures, recordFailure } from "../../utils/lockout.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import { NotificationType } from "../notifications/notifications.interface.js";
import { notificationsService } from "../notifications/notifications.service.js";
import { usersService } from "../users/users.service.js";
import type {
  AuthContext,
  IChangePasswordBody,
  ILoginBody,
  IMfaDisableBody,
  IMfaVerifyBody,
  IRegisterBody,
  IResetPasswordBody,
  IssuedTokens,
  LoginResult,
} from "./auth.interface.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESET_REQUEST_GAP_MS = 60 * 1000;
const TOTP_ISSUER = "Business OS";
const TOTP_STEP_SECONDS = 30;

// Compared against when the email is unknown, so response time does not reveal who has an account.
const dummyPasswordHash = bcrypt.hash(randomToken(), env.BCRYPT_COST);

// A security alert must never stop the request it is about, so a failure here is only logged.
const sendSecurityEmail = (userId: string, type: NotificationType) =>
  notificationsService.notifySafely([
    // One per hour, so someone guessing passwords cannot flood the inbox.
    { type, userId, params: {}, dedupeKey: `${type}:${userId}:${Math.floor(Date.now() / (60 * 60 * 1000))}` },
  ]);

const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

const toEpochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

const createRefreshToken = async (tx: Prisma.TransactionClient, userId: string, familyId: string) => {
  const raw = randomToken();
  const token = await tx.refreshToken.create({
    data: { userId, familyId, tokenHash: sha256Hex(raw), expiresAt: refreshExpiry() },
  });
  return { raw, id: token.id };
};

type UserWithWorkspaces = NonNullable<Awaited<ReturnType<typeof usersService.findById>>>;

const openSession = async (
  tx: Prisma.TransactionClient,
  user: UserWithWorkspaces,
  context: RequestContext,
  mfaVerifiedAt: Date | null,
): Promise<IssuedTokens> => {
  const session = await tx.userSession.create({
    data: { userId: user.id, ip: context.ip, userAgent: context.userAgent, mfaVerifiedAt },
  });
  const refresh = await createRefreshToken(tx, user.id, session.id);
  const updated = await usersService.recordLogin(tx, user.id);

  return {
    accessToken: signAccessToken({
      sub: user.id,
      wid: usersService.defaultWorkspaceId(user),
      sid: session.id,
      tv: user.tokenVersion,
      ...(mfaVerifiedAt ? { mfa_at: toEpochSeconds(mfaVerifiedAt) } : {}),
    }),
    expiresIn: accessTokenTtlSeconds,
    refreshToken: refresh.raw,
    user: usersService.toPublicUser(updated),
  };
};

const revokeSessions = async (tx: Prisma.TransactionClient, where: { userId: string; sessionId?: string }) => {
  const now = new Date();
  await tx.refreshToken.updateMany({
    where: { userId: where.userId, revokedAt: null, ...(where.sessionId ? { familyId: where.sessionId } : {}) },
    data: { revokedAt: now },
  });
  await tx.userSession.updateMany({
    where: { userId: where.userId, revokedAt: null, ...(where.sessionId ? { id: where.sessionId } : {}) },
    data: { revokedAt: now },
  });
};

const register = async (body: IRegisterBody, context: RequestContext) => {
  if (!env.REGISTRATION_ENABLED) throw new AppError(403, ErrorCode.REGISTRATION_DISABLED);

  const passwordHash = await bcrypt.hash(body.password, env.BCRYPT_COST);

  try {
    return await prisma.$transaction(async (tx) => {
      const { user, workspaceId } = await usersService.createWithWorkspace(tx, {
        email: body.email,
        name: body.name,
        passwordHash,
      });
      if (body.locale) await tx.user.update({ where: { id: user.id }, data: { locale: body.locale } });

      const tokens = await openSession(
        tx,
        { ...user, workspaces: [{ userId: user.id, workspaceId, isDefault: true, createdAt: user.createdAt }] },
        context,
        null,
      );
      await auditService.record(tx, {
        action: "auth.registered",
        context,
        workspaceId,
        actorUserId: user.id,
        entityType: "user",
        entityId: user.id,
        after: { email: user.email },
      });
      return tokens;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new AppError(409, ErrorCode.EMAIL_TAKEN);
    throw error;
  }
};

const login = async (body: ILoginBody, context: RequestContext): Promise<LoginResult> => {
  const lockKey = `login:${sha256Hex(body.email)}`;
  await assertNotLocked(lockKey);

  const user = await usersService.findByEmail(body.email);
  const passwordMatches = await bcrypt.compare(body.password, user?.passwordHash ?? (await dummyPasswordHash));

  if (!user || !passwordMatches || user.status !== "ACTIVE") {
    const justLocked = await recordFailure(lockKey);
    if (justLocked && user) await sendSecurityEmail(user.id, NotificationType.ACCOUNT_LOCKED);
    securityLogger.warn({ user_id: user?.id, request_id: context.requestId }, "login failed");
    await auditService.recordStandalone({
      action: "auth.login_failed",
      context,
      workspaceId: user ? usersService.defaultWorkspaceId(user) : null,
      actorUserId: user?.id,
      entityType: "user",
      entityId: user?.id,
      after: { email: body.email },
    });
    throw new AppError(401, ErrorCode.INVALID_CREDENTIALS);
  }

  await clearFailures(lockKey);

  if (user.mfaEnabled) {
    return { mfaRequired: true, challengeToken: signMfaChallenge({ sub: user.id, tv: user.tokenVersion }) };
  }

  const tokens = await prisma.$transaction(async (tx) => {
    const issued = await openSession(tx, user, context, null);
    await auditService.record(tx, {
      action: "auth.login",
      context,
      workspaceId: usersService.defaultWorkspaceId(user),
      actorUserId: user.id,
      entityType: "user",
      entityId: user.id,
    });
    return issued;
  });
  return { mfaRequired: false, ...tokens };
};

// A code is accepted once only: the time step is claimed atomically, which also defeats two
// requests racing with the same code.
const checkTotp = async (userId: string, code: string, requireConfirmed: boolean) => {
  const factor = await prisma.mfaFactor.findUnique({ where: { userId_type: { userId, type: "TOTP" } } });
  if (!factor || (requireConfirmed && !factor.confirmedAt)) return false;

  const secret = decryptSecret(factor.encryptedSecret, userId);
  const result = await verifyTotpCode({
    secret,
    token: code,
    epochTolerance: TOTP_STEP_SECONDS,
    ...(factor.lastUsedStep !== null ? { afterTimeStep: Number(factor.lastUsedStep) } : {}),
  });
  if (!result.valid) return false;

  const step = BigInt(Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + result.delta);
  const claimed = await prisma.mfaFactor.updateMany({
    where: { id: factor.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
    data: { lastUsedStep: step },
  });
  return claimed.count === 1;
};

// Shared by every endpoint taking a TOTP code: 5 wrong codes lock MFA for 15 minutes.
const assertValidTotp = async (user: UserWithWorkspaces, code: string, context: RequestContext, requireConfirmed = true) => {
  const lockKey = `mfa:${user.id}`;
  await assertNotLocked(lockKey);

  if (!(await checkTotp(user.id, code, requireConfirmed))) {
    await recordFailure(lockKey);
    securityLogger.warn({ user_id: user.id, request_id: context.requestId }, "mfa code rejected");
    await auditService.recordStandalone({
      action: "auth.mfa_failed",
      context,
      workspaceId: usersService.defaultWorkspaceId(user),
      actorUserId: user.id,
      entityType: "user",
      entityId: user.id,
    });
    throw new AppError(401, ErrorCode.MFA_INVALID_CODE);
  }
  await clearFailures(lockKey);
};

const verifyMfaLogin = async (body: IMfaVerifyBody, context: RequestContext) => {
  let claims;
  try {
    claims = verifyMfaChallenge(body.challengeToken);
  } catch {
    throw new AppError(401, ErrorCode.MFA_CHALLENGE_INVALID);
  }

  const user = await usersService.findById(claims.sub);
  if (!user || user.status !== "ACTIVE" || !user.mfaEnabled || user.tokenVersion !== claims.tv) {
    throw new AppError(401, ErrorCode.MFA_CHALLENGE_INVALID);
  }

  await assertValidTotp(user, body.code, context);

  return prisma.$transaction(async (tx) => {
    const issued = await openSession(tx, user, context, new Date());
    await auditService.record(tx, {
      action: "auth.login",
      context,
      workspaceId: usersService.defaultWorkspaceId(user),
      actorUserId: user.id,
      entityType: "user",
      entityId: user.id,
      after: { mfa: true },
    });
    return issued;
  });
};

const refresh = async (rawToken: string | undefined, context: RequestContext) => {
  if (!rawToken) throw new AppError(401, ErrorCode.REFRESH_INVALID);
  const tokenHash = sha256Hex(rawToken);

  // Reuse must COMMIT its revocation before the 401 goes out, so this returns an outcome instead
  // of throwing inside the transaction (a throw would roll the revocation back).
  const outcome = await prisma.$transaction(async (tx) => {
    // The row lock makes two simultaneous refreshes with one token run one after the other.
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM refresh_tokens WHERE token_hash = ${tokenHash} FOR UPDATE`;
    if (!locked) return { kind: "invalid" as const };

    const token = await tx.refreshToken.findUniqueOrThrow({
      where: { id: locked.id },
      include: { session: true, user: { include: { workspaces: true } } },
    });
    const workspaceId = usersService.defaultWorkspaceId(token.user);

    if (token.replacedById) {
      await revokeSessions(tx, { userId: token.userId, sessionId: token.familyId });
      await usersService.bumpTokenVersion(tx, token.userId);
      await auditService.record(tx, {
        action: "auth.refresh_reused",
        context,
        workspaceId,
        actorUserId: token.userId,
        entityType: "user_session",
        entityId: token.familyId,
      });
      return { kind: "reused" as const, userId: token.userId, familyId: token.familyId };
    }

    if (
      token.revokedAt ||
      token.expiresAt <= new Date() ||
      token.session.revokedAt ||
      token.user.status !== "ACTIVE"
    ) {
      return { kind: "invalid" as const };
    }

    const next = await createRefreshToken(tx, token.userId, token.familyId);
    await tx.refreshToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date(), replacedById: next.id },
    });
    await tx.userSession.update({
      where: { id: token.familyId },
      data: { lastSeenAt: new Date(), ip: context.ip, userAgent: context.userAgent },
    });

    const mfaAt = token.session.mfaVerifiedAt;
    return {
      kind: "rotated" as const,
      tokens: {
        accessToken: signAccessToken({
          sub: token.userId,
          wid: workspaceId,
          sid: token.familyId,
          tv: token.user.tokenVersion,
          ...(mfaAt ? { mfa_at: toEpochSeconds(mfaAt) } : {}),
        }),
        expiresIn: accessTokenTtlSeconds,
        refreshToken: next.raw,
        user: usersService.toPublicUser(token.user),
      } satisfies IssuedTokens,
    };
  });

  if (outcome.kind === "reused") {
    securityLogger.error(
      { user_id: outcome.userId, session_id: outcome.familyId, request_id: context.requestId },
      "refresh token reuse detected",
    );
    await sendSecurityEmail(outcome.userId, NotificationType.SESSION_REUSE_DETECTED);
    throw new AppError(401, ErrorCode.REFRESH_REUSED);
  }
  if (outcome.kind === "invalid") throw new AppError(401, ErrorCode.REFRESH_INVALID);
  return outcome.tokens;
};

const logout = async (rawToken: string | undefined, context: RequestContext) => {
  if (!rawToken) return;
  const token = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256Hex(rawToken) },
    include: { user: { include: { workspaces: true } } },
  });
  if (!token) return;

  await prisma.$transaction(async (tx) => {
    await revokeSessions(tx, { userId: token.userId, sessionId: token.familyId });
    await auditService.record(tx, {
      action: "auth.logout",
      context,
      workspaceId: usersService.defaultWorkspaceId(token.user),
      actorUserId: token.userId,
      entityType: "user_session",
      entityId: token.familyId,
    });
  });
};

const logoutAll = (auth: AuthContext, context: RequestContext) =>
  prisma.$transaction(async (tx) => {
    await revokeSessions(tx, { userId: auth.userId });
    await usersService.bumpTokenVersion(tx, auth.userId);
    await auditService.record(tx, {
      action: "auth.logout_all",
      context,
      workspaceId: auth.workspaceId,
      actorUserId: auth.userId,
      entityType: "user",
      entityId: auth.userId,
    });
  });

// Runs on every authenticated request. Checks signature and expiry first, then the database, so a
// disabled user or a revoked session loses access at once rather than when the token expires.
const authenticate = async (token: string): Promise<AuthContext> => {
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    throw new AppError(401, expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID);
  }

  const session = await prisma.userSession.findUnique({
    where: { id: claims.sid },
    select: {
      userId: true,
      revokedAt: true,
      user: { select: { status: true, tokenVersion: true, mfaEnabled: true } },
    },
  });

  if (
    !session ||
    session.userId !== claims.sub ||
    session.revokedAt ||
    session.user.status !== "ACTIVE" ||
    session.user.tokenVersion !== claims.tv
  ) {
    throw new AppError(401, ErrorCode.TOKEN_INVALID);
  }

  return {
    userId: claims.sub,
    workspaceId: claims.wid,
    sessionId: claims.sid,
    mfaEnabled: session.user.mfaEnabled,
    ...(claims.mfa_at ? { mfaAt: claims.mfa_at } : {}),
  };
};

const listSessions = async (auth: AuthContext) => {
  const sessions = await prisma.userSession.findMany({
    where: { userId: auth.userId, revokedAt: null },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true },
  });
  return sessions.map((session) => ({ ...session, current: session.id === auth.sessionId }));
};

const revokeSession = async (auth: AuthContext, sessionId: string, context: RequestContext) => {
  const session = await prisma.userSession.findFirst({
    where: { id: sessionId, userId: auth.userId, revokedAt: null },
    select: { id: true },
  });
  // 404 for someone else's session too, so its existence is not revealed.
  if (!session) throw new AppError(404, ErrorCode.NOT_FOUND);

  await prisma.$transaction(async (tx) => {
    await revokeSessions(tx, { userId: auth.userId, sessionId });
    await auditService.record(tx, {
      action: "auth.session_revoked",
      context,
      workspaceId: auth.workspaceId,
      actorUserId: auth.userId,
      entityType: "user_session",
      entityId: sessionId,
    });
  });
};

const requireUser = async (userId: string) => {
  const user = await usersService.findById(userId);
  if (!user) throw new AppError(401, ErrorCode.TOKEN_INVALID);
  return user;
};

// Password checks on already-logged-in routes share the login lockout, so a stolen access token
// cannot be used to guess the password.
const assertPassword = async (user: UserWithWorkspaces, password: string) => {
  const lockKey = `login:${sha256Hex(user.email.toLowerCase())}`;
  await assertNotLocked(lockKey);
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    await recordFailure(lockKey);
    throw new AppError(401, ErrorCode.INVALID_CREDENTIALS);
  }
  await clearFailures(lockKey);
};

const startMfaSetup = async (auth: AuthContext, password: string, context: RequestContext) => {
  const user = await requireUser(auth.userId);
  if (user.mfaEnabled) throw new AppError(409, ErrorCode.MFA_ALREADY_ENABLED);
  await assertPassword(user, password);

  const secret = generateSecret();
  const encryptedSecret = encryptSecret(secret, user.id);

  await prisma.$transaction(async (tx) => {
    await tx.mfaFactor.upsert({
      where: { userId_type: { userId: user.id, type: "TOTP" } },
      create: { userId: user.id, type: "TOTP", encryptedSecret },
      update: { encryptedSecret, confirmedAt: null, lastUsedStep: null },
    });
    await auditService.record(tx, {
      action: "auth.mfa_setup_started",
      context,
      workspaceId: auth.workspaceId,
      actorUserId: user.id,
      entityType: "user",
      entityId: user.id,
    });
  });

  return { secret, otpauthUri: generateURI({ issuer: TOTP_ISSUER, label: user.email, secret }) };
};

const confirmMfaSetup = async (auth: AuthContext, code: string, context: RequestContext) => {
  const user = await requireUser(auth.userId);
  if (user.mfaEnabled) throw new AppError(409, ErrorCode.MFA_ALREADY_ENABLED);

  const factor = await prisma.mfaFactor.findUnique({ where: { userId_type: { userId: user.id, type: "TOTP" } } });
  if (!factor) throw new AppError(409, ErrorCode.MFA_NOT_STARTED);

  await assertValidTotp(user, code, context, false);

  await prisma.$transaction(async (tx) => {
    await tx.mfaFactor.update({ where: { id: factor.id }, data: { confirmedAt: new Date() } });
    await usersService.setMfaEnabled(tx, user.id, true);
    await auditService.record(tx, {
      action: "auth.mfa_enabled",
      context,
      workspaceId: auth.workspaceId,
      actorUserId: user.id,
      entityType: "user",
      entityId: user.id,
    });
  });
};

const disableMfa = async (auth: AuthContext, body: IMfaDisableBody, context: RequestContext) => {
  const user = await requireUser(auth.userId);
  if (!user.mfaEnabled) throw new AppError(409, ErrorCode.MFA_NOT_ENABLED);
  await assertPassword(user, body.password);
  await assertValidTotp(user, body.code, context);

  await prisma.$transaction(async (tx) => {
    await tx.mfaFactor.delete({ where: { userId_type: { userId: user.id, type: "TOTP" } } });
    await usersService.setMfaEnabled(tx, user.id, false);
    await auditService.record(tx, {
      action: "auth.mfa_disabled",
      context,
      workspaceId: auth.workspaceId,
      actorUserId: user.id,
      entityType: "user",
      entityId: user.id,
    });
  });
};

const stepUpMfa = async (auth: AuthContext, code: string, context: RequestContext) => {
  const user = await requireUser(auth.userId);
  if (!user.mfaEnabled) throw new AppError(409, ErrorCode.MFA_NOT_ENABLED);
  await assertValidTotp(user, code, context);

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.userSession.update({ where: { id: auth.sessionId }, data: { mfaVerifiedAt: now } });
    await auditService.record(tx, {
      action: "auth.mfa_step_up",
      context,
      workspaceId: auth.workspaceId,
      actorUserId: user.id,
      entityType: "user_session",
      entityId: auth.sessionId,
    });
  });

  return {
    accessToken: signAccessToken({
      sub: user.id,
      wid: auth.workspaceId,
      sid: auth.sessionId,
      tv: user.tokenVersion,
      mfa_at: toEpochSeconds(now),
    }),
    expiresIn: accessTokenTtlSeconds,
  };
};

// Ends every session, including this one: the client must log in again with the new password.
const changePassword = async (auth: AuthContext, body: IChangePasswordBody, context: RequestContext) => {
  const user = await requireUser(auth.userId);
  await assertPassword(user, body.currentPassword);
  const passwordHash = await bcrypt.hash(body.newPassword, env.BCRYPT_COST);

  await prisma.$transaction(async (tx) => {
    await usersService.setPasswordHash(tx, user.id, passwordHash);
    await revokeSessions(tx, { userId: user.id });
    await usersService.bumpTokenVersion(tx, user.id);
    await auditService.record(tx, {
      action: "auth.password_changed",
      context,
      workspaceId: auth.workspaceId,
      actorUserId: user.id,
      entityType: "user",
      entityId: user.id,
    });
  });
  await sendSecurityEmail(user.id, NotificationType.PASSWORD_CHANGED);
};

// Answers the same whether or not the email has an account, so nobody can test which emails do.
const forgotPassword = async (email: string, context: RequestContext) => {
  const user = await usersService.findByEmail(email);
  if (!user || user.status !== "ACTIVE") return;

  const recent = await prisma.passwordResetToken.count({
    where: { userId: user.id, createdAt: { gt: new Date(Date.now() - RESET_REQUEST_GAP_MS) } },
  });
  if (recent > 0) return;

  const token = randomToken();
  await prisma.$transaction(async (tx) => {
    // Only the newest link works.
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    const reset = await tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
    });
    await auditService.record(tx, {
      action: "auth.password_reset_requested",
      context,
      workspaceId: usersService.defaultWorkspaceId(user),
      actorUserId: user.id,
      entityType: "user",
      entityId: user.id,
    });
    await notificationsService.dispatch(tx, [
      {
        type: NotificationType.PASSWORD_RESET,
        userId: user.id,
        params: { tokenEncrypted: encryptSecret(token, reset.id) },
        entityType: "password_reset",
        entityId: reset.id,
        dedupeKey: `${NotificationType.PASSWORD_RESET}:${reset.id}`,
      },
    ]);
  });
};

const resetPassword = async (body: IResetPasswordBody, context: RequestContext) => {
  const passwordHash = await bcrypt.hash(body.password, env.BCRYPT_COST);

  const user = await prisma.$transaction(async (tx) => {
    // Marking it used in one statement means two requests with one link cannot both succeed.
    const { count } = await tx.passwordResetToken.updateMany({
      where: { tokenHash: sha256Hex(body.token), usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw new AppError(400, ErrorCode.PASSWORD_RESET_INVALID);

    const { userId } = await tx.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(body.token) } });
    const owner = await usersService.findById(userId);
    if (owner?.status !== "ACTIVE") throw new AppError(400, ErrorCode.PASSWORD_RESET_INVALID);

    await usersService.setPasswordHash(tx, userId, passwordHash);
    await revokeSessions(tx, { userId });
    await usersService.bumpTokenVersion(tx, userId);
    await auditService.record(tx, {
      action: "auth.password_reset",
      context,
      workspaceId: usersService.defaultWorkspaceId(owner),
      actorUserId: userId,
      entityType: "user",
      entityId: userId,
    });
    return owner;
  });

  await clearFailures(`login:${sha256Hex(user.email)}`);
  await sendSecurityEmail(user.id, NotificationType.PASSWORD_CHANGED);
};

export const authService = {
  register,
  login,
  verifyMfaLogin,
  refresh,
  logout,
  logoutAll,
  authenticate,
  listSessions,
  revokeSession,
  startMfaSetup,
  confirmMfaSetup,
  disableMfa,
  stepUpMfa,
  changePassword,
  forgotPassword,
  resetPassword,
};
