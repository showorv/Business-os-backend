import { UnrecoverableError } from "bullmq";
import { logger } from "../../lib/logger.js";
import type { Prisma } from "../../lib/prisma.js";
import { prisma } from "../../lib/prisma.js";
import { AdapterError, redactPayload, type CanonicalLine, type ConnectionContext, type IntegrationAdapter } from "../integrations/adapter.js";
import { findAdapter } from "../integrations/registry.js";
import { Permission } from "../constants/permissions.js";
import { membersService } from "../modules/members/members.service.js";
import { NotificationType } from "../modules/notifications/notifications.interface.js";
import { notificationsService } from "../modules/notifications/notifications.service.js";
import { statementLinesService } from "../modules/statement-lines/statement-lines.service.js";
import { decryptForWorkspace, sha256Hex } from "../utils/crypto.js";
import { EventType, publishEvent } from "../utils/outbox.js";

const MAX_PAGES_PER_RUN = 100;
// A crashed worker can't release its claim, so an old one is taken as abandoned.
const CLAIM_EXPIRES_MS = 30 * 60 * 1000;
const FAILURES_BEFORE_ALERT = 3;
const MAX_LINES_TO_MATCH = 500;

type StoredConnection = Prisma.IntegrationConnectionGetPayload<object>;

// One sync at a time per connection, whichever worker gets here first.
const claim = async (connectionId: string) => {
  const { count } = await prisma.integrationConnection.updateMany({
    where: {
      id: connectionId,
      status: "ACTIVE",
      OR: [{ syncingSince: null }, { syncingSince: { lt: new Date(Date.now() - CLAIM_EXPIRES_MS) } }],
    },
    data: { syncingSince: new Date() },
  });
  return count === 1;
};

const tellManagers = async (connection: StoredConnection, type: NotificationType, params: Record<string, string | number>, key: string) => {
  const managers = await membersService.listUserIdsWithPermission(connection.businessId, Permission.INTEGRATIONS_MANAGE);
  await notificationsService.notifySafely(
    managers.map((userId) => ({
      type,
      userId,
      workspaceId: connection.workspaceId,
      businessId: connection.businessId,
      params: { provider: connection.provider, connectionId: connection.id, ...params },
      entityType: "integration_connection",
      entityId: connection.id,
      dedupeKey: `${type}:${connection.id}:${key}:${userId}`,
    })),
  );
};

// Normalizes one page. A record that can't be read is counted but doesn't stop the rest.
const normalizePage = (adapter: IntegrationAdapter, connection: StoredConnection, records: unknown[]) => {
  const lines: { line: CanonicalLine; dedupeHash: string }[] = [];
  let failed = 0;
  for (const record of records) {
    try {
      const line = adapter.normalize(record);
      if (!line.providerTxnId || line.amountMinor <= 0n) throw new Error("unusable record");
      lines.push({ line, dedupeHash: sha256Hex(`provider|${connection.id}|${line.providerTxnId}`) });
    } catch (error) {
      failed += 1;
      logger.warn({ err: error, connection_id: connection.id }, "could not read a provider record");
    }
  }
  return { lines, failed };
};

const fetchAllPages = async (adapter: IntegrationAdapter, connection: StoredConnection, context: ConnectionContext, runId: string) => {
  let cursor = connection.syncCursor;

  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const result = await adapter.fetchTransactions(context, cursor);
    const { lines, failed } = normalizePage(adapter, connection, result.records);
    const nextCursor = result.nextCursor ?? cursor;

    // Lines and cursor commit together, so a crash resumes from here with no gap and no repeat.
    await prisma.$transaction(async (tx) => {
      await tx.rawPayload.create({
        data: { businessId: connection.businessId, connectionId: connection.id, kind: "FETCH", payload: redactPayload(result.records) as Prisma.InputJsonValue },
      });
      const outcome = await statementLinesService.ingest(
        tx,
        { workspaceId: connection.workspaceId, businessId: connection.businessId, financialAccountId: connection.financialAccountId, connectionId: connection.id },
        lines,
      );
      await tx.integrationConnection.update({ where: { id: connection.id }, data: { syncCursor: nextCursor } });
      await tx.syncRun.update({
        where: { id: runId },
        data: {
          fetched: { increment: result.records.length },
          newLines: { increment: outcome.created.length },
          skipped: { increment: outcome.skipped },
          failed: { increment: failed },
          cursorAfter: nextCursor,
        },
      });
    });
    cursor = nextCursor;
    if (!result.hasMore) break;
  }
};

const recordFailure = async (connection: StoredConnection, runId: string, error: unknown) => {
  const code = error instanceof AdapterError ? error.code : "SYNC_ERROR";
  await prisma.syncRun.update({ where: { id: runId }, data: { status: "FAILED", errorCode: code.slice(0, 100), finishedAt: new Date() } });

  const updated = await prisma.integrationConnection.update({
    where: { id: connection.id },
    data: {
      syncingSince: null,
      consecutiveFailures: { increment: 1 },
      ...(error instanceof AdapterError && error.failure === "NEEDS_REAUTH" ? { status: "NEEDS_REAUTH" as const } : {}),
    },
  });

  if (error instanceof AdapterError && error.failure === "NEEDS_REAUTH") {
    await tellManagers(connection, NotificationType.INTEGRATION_NEEDS_REAUTH, {}, runId);
  } else if (updated.consecutiveFailures === FAILURES_BEFORE_ALERT) {
    await tellManagers(connection, NotificationType.INTEGRATION_SYNC_FAILING, { failures: updated.consecutiveFailures }, runId);
  }
};

// Runs in the worker. Retryable errors are thrown, so BullMQ retries with backoff, up to 5 times.
// After that the job stays in the failed list, which is the dead-letter queue, and goes to Sentry.
export const runSync = async (connectionId: string) => {
  if (!(await claim(connectionId))) return;

  const connection = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const run = await prisma.syncRun.create({ data: { workspaceId: connection.workspaceId, businessId: connection.businessId, connectionId } });

  try {
    const adapter = findAdapter(connection.provider);
    if (!adapter) throw new AdapterError("PERMANENT", "PROVIDER_NOT_AVAILABLE");

    const context: ConnectionContext = {
      connectionId,
      secrets: JSON.parse(decryptForWorkspace(connection.encryptedSecrets, connection.workspaceId, connectionId)) as Record<string, string>,
    };
    await adapter.authenticate(context);
    await fetchAllPages(adapter, connection, context, run.id);
    const balance = adapter.fetchBalance ? await adapter.fetchBalance(context) : null;

    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: new Date(), consecutiveFailures: 0, syncingSince: null, ...(balance !== null ? { lastBalanceMinor: balance } : {}) },
    });
    await prisma.syncRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", finishedAt: new Date() } });

    // It runs as the person who set the connection up, with what they may do today.
    const actor = await membersService.resolveContext(connection.createdBy, connection.businessId);
    if (actor) {
      // Every open line, not only new ones: an entry added since may now match an older line.
      const open = await prisma.statementLine.findMany({
        where: { connectionId, status: "UNMATCHED" },
        select: { id: true },
        orderBy: { id: "asc" },
        take: MAX_LINES_TO_MATCH,
      });
      await statementLinesService.matchLines(actor, open.map((line) => line.id), { ip: null, userAgent: "worker", requestId: `sync-${run.id}` });
    }
  } catch (error) {
    await recordFailure(connection, run.id, error);
    // Retrying can't fix a revoked login or a request the provider calls invalid.
    if (error instanceof AdapterError && error.failure !== "RETRYABLE") throw new UnrecoverableError(error.code);
    throw error;
  }
};

// The timer. Each connection comes due by its own setting.
export const queueDueSyncs = async () => {
  const connections = await prisma.integrationConnection.findMany({
    where: { status: "ACTIVE", syncingSince: null, business: { status: "ACTIVE" } },
    select: { id: true, workspaceId: true, businessId: true, createdBy: true, syncEveryHours: true, lastSyncedAt: true },
  });
  const due = connections.filter(
    (connection) => !connection.lastSyncedAt || connection.lastSyncedAt.getTime() + connection.syncEveryHours * 60 * 60 * 1000 <= Date.now(),
  );
  for (const connection of due) {
    await prisma.$transaction((tx) =>
      publishEvent(tx, { userId: connection.createdBy, workspaceId: connection.workspaceId, businessId: connection.businessId }, EventType.INTEGRATION_SYNC_REQUESTED, {
        connectionId: connection.id,
      }),
    );
  }
  return due.length;
};
