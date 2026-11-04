import { randomUUID } from "node:crypto";
import { z } from "zod";
import { securityLogger } from "../../../lib/logger.js";
import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { redactPayload, type IntegrationAdapter } from "../../integrations/adapter.js";
import { findAdapter, listAdapters } from "../../integrations/registry.js";
import { decryptForWorkspace, encryptForWorkspace } from "../../utils/crypto.js";
import { AppError, ErrorCode, isUniqueViolation } from "../../utils/errors.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { accountsService } from "../accounts/accounts.service.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { ICreateConnectionBody, IReauthorizeBody, IRunsQuery, IUpdateConnectionBody } from "./integrations.interface.js";

// Never includes the secrets.
const publicFields = {
  id: true,
  financialAccountId: true,
  provider: true,
  status: true,
  syncCursor: true,
  syncEveryHours: true,
  lastSyncedAt: true,
  lastBalanceMinor: true,
  consecutiveFailures: true,
  createdBy: true,
  createdAt: true,
} as const;

const requireAdapter = (key: string) => {
  const adapter = findAdapter(key);
  if (!adapter) throw new AppError(422, ErrorCode.PROVIDER_NOT_AVAILABLE, { provider: key });
  return adapter;
};

const checkSecrets = (adapter: IntegrationAdapter, secrets: Record<string, string>) => {
  const parsed = adapter.secretsSchema.safeParse(secrets);
  // Only names the fields wrong. The values must never appear in an error or a log.
  if (!parsed.success) {
    throw new AppError(422, ErrorCode.INTEGRATION_SECRETS_INVALID, { fields: parsed.error.issues.map((issue) => issue.path.join(".")) });
  }
  return JSON.stringify(parsed.data);
};

const listProviders = () =>
  listAdapters().map((adapter) => ({
    key: adapter.key,
    name: adapter.name,
    capabilities: adapter.capabilities,
    secretFields: adapter.secretsSchema instanceof z.ZodObject ? Object.keys(adapter.secretsSchema.shape) : [],
  }));

const create = async (business: BusinessContext, body: ICreateConnectionBody, context: RequestContext) => {
  const adapter = requireAdapter(body.provider);
  const plain = checkSecrets(adapter, body.secrets);

  try {
    return await withBusinessScope(business, async (tx) => {
      await accountsService.getUsable(tx, business.businessId, body.financialAccountId);

      // The id is set here because it is bound into the encrypted value.
      const id = randomUUID();
      const connection = await tx.integrationConnection.create({
        data: {
          id,
          workspaceId: business.workspaceId,
          businessId: business.businessId,
          financialAccountId: body.financialAccountId,
          provider: body.provider,
          encryptedSecrets: encryptForWorkspace(plain, business.workspaceId, id),
          syncEveryHours: body.syncEveryHours,
          createdBy: business.userId,
        },
        select: publicFields,
      });
      await auditService.recordForBusiness(tx, business, {
        action: "integration.connected",
        context,
        entityType: "integration_connection",
        entityId: id,
        after: { provider: body.provider, financialAccountId: body.financialAccountId, syncEveryHours: body.syncEveryHours },
      });
      await publishEvent(tx, business, EventType.INTEGRATION_SYNC_REQUESTED, { connectionId: id });
      return connection;
    });
  } catch (error) {
    throw isUniqueViolation(error) ? new AppError(409, ErrorCode.CONNECTION_ALREADY_EXISTS) : error;
  }
};

const list = (business: BusinessContext) =>
  withBusinessScope(business, (tx) =>
    tx.integrationConnection.findMany({ where: { businessId: business.businessId }, orderBy: { id: "desc" }, select: publicFields }),
  );

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, connectionId: string) => {
  const connection = await tx.integrationConnection.findFirst({ where: { id: connectionId, businessId } });
  if (!connection) throw new AppError(404, ErrorCode.NOT_FOUND);
  return connection;
};

const getOne = async (business: BusinessContext, connectionId: string) => {
  const connection = await withBusinessScope(business, (tx) =>
    tx.integrationConnection.findFirst({ where: { id: connectionId, businessId: business.businessId }, select: publicFields }),
  );
  if (!connection) throw new AppError(404, ErrorCode.NOT_FOUND);
  return connection;
};

const update = (business: BusinessContext, connectionId: string, body: IUpdateConnectionBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await findOrThrow(tx, business.businessId, connectionId);
    // A connection that lost its sign-in can only come back with new credentials.
    if (body.status === "ACTIVE" && before.status === "NEEDS_REAUTH") {
      throw new AppError(409, ErrorCode.CONNECTION_NOT_ACTIVE, { status: before.status });
    }
    const after = await tx.integrationConnection.update({ where: { id: connectionId }, data: body, select: publicFields });
    await auditService.recordForBusiness(tx, business, {
      action: body.status === "DISABLED" ? "integration.disabled" : "integration.updated",
      context,
      entityType: "integration_connection",
      entityId: connectionId,
      before: { status: before.status, syncEveryHours: before.syncEveryHours },
      after: { status: after.status, syncEveryHours: after.syncEveryHours },
    });
    return after;
  });

const reauthorize = (business: BusinessContext, connectionId: string, body: IReauthorizeBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await findOrThrow(tx, business.businessId, connectionId);
    const plain = checkSecrets(requireAdapter(before.provider), body.secrets);

    const after = await tx.integrationConnection.update({
      where: { id: connectionId },
      data: { encryptedSecrets: encryptForWorkspace(plain, business.workspaceId, connectionId), status: "ACTIVE", consecutiveFailures: 0 },
      select: publicFields,
    });
    await auditService.recordForBusiness(tx, business, {
      action: "integration.reauthorized",
      context,
      entityType: "integration_connection",
      entityId: connectionId,
      before: { status: before.status },
      after: { status: after.status },
    });
    await publishEvent(tx, business, EventType.INTEGRATION_SYNC_REQUESTED, { connectionId });
    return after;
  });

const syncNow = (business: BusinessContext, connectionId: string) =>
  withBusinessScope(business, async (tx) => {
    const connection = await findOrThrow(tx, business.businessId, connectionId);
    if (connection.status !== "ACTIVE") throw new AppError(409, ErrorCode.CONNECTION_NOT_ACTIVE, { status: connection.status });
    await publishEvent(tx, business, EventType.INTEGRATION_SYNC_REQUESTED, { connectionId });
    return { queued: true };
  });

const listRuns = (business: BusinessContext, connectionId: string, query: IRunsQuery) =>
  withBusinessScope(business, async (tx) => {
    await findOrThrow(tx, business.businessId, connectionId);
    const rows = await tx.syncRun.findMany({ where: { connectionId }, orderBy: { id: "desc" }, ...pageArgs(query) });
    return toPage(rows, query.limit);
  });

const WEBHOOK_PAYLOAD_LIMIT_BYTES = 64 * 1024;

const parseForStorage = (rawBody: Buffer) => {
  if (rawBody.length > WEBHOOK_PAYLOAD_LIMIT_BYTES) return { truncated: true };
  try {
    return redactPayload(JSON.parse(rawBody.toString("utf8"))) as Prisma.InputJsonValue;
  } catch {
    return { unreadable: true };
  }
};

const UUID = z.uuid();

// Answers quickly, as providers expect. The stored payload only triggers a sync: what gets recorded
// always comes from the provider's own API, so a forged body couldn't add a statement line anyway.
const receiveWebhook = async (connectionId: string, headers: Record<string, string | undefined>, rawBody: Buffer, ip: string | undefined) => {
  if (!UUID.safeParse(connectionId).success) throw new AppError(404, ErrorCode.NOT_FOUND);

  const connection = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
  const adapter = connection && findAdapter(connection.provider);
  if (!connection || !adapter?.capabilities.webhooks || !adapter.verifyWebhook) throw new AppError(404, ErrorCode.NOT_FOUND);

  const secrets = JSON.parse(decryptForWorkspace(connection.encryptedSecrets, connection.workspaceId, connection.id)) as Record<string, string>;
  if (!adapter.verifyWebhook(headers, rawBody, secrets)) {
    securityLogger.warn({ connection_id: connectionId, ip }, "webhook signature rejected");
    throw new AppError(401, ErrorCode.UNAUTHENTICATED);
  }

  await prisma.$transaction(async (tx) => {
    await tx.rawPayload.create({
      data: { businessId: connection.businessId, connectionId, kind: "WEBHOOK", payload: parseForStorage(rawBody) },
    });
    if (connection.status === "ACTIVE") {
      await publishEvent(
        tx,
        { userId: connection.createdBy, workspaceId: connection.workspaceId, businessId: connection.businessId },
        EventType.INTEGRATION_SYNC_REQUESTED,
        { connectionId },
      );
    }
  });
};

export const integrationsService = { listProviders, create, list, getOne, update, reauthorize, syncNow, listRuns, receiveWebhook };
