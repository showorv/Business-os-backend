import * as Sentry from "@sentry/node";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { QueueName, queues } from "../../lib/queues.js";
import { deleteObject } from "../../lib/storage.js";
import { Permission } from "../constants/permissions.js";
import { auditService } from "../modules/audit/audit.service.js";
import { membersService } from "../modules/members/members.service.js";
import { NotificationType } from "../modules/notifications/notifications.interface.js";
import { notificationsService } from "../modules/notifications/notifications.service.js";
import { recurringSchedulesService } from "../modules/recurring-schedules/recurring-schedules.service.js";
import { reportsService } from "../modules/reports/reports.service.js";
import { statementLinesService } from "../modules/statement-lines/statement-lines.service.js";
import { requeueStuckDeliveries } from "./deliveryRelay.js";
import { queueDueSyncs } from "./integrationSync.js";
import { scanOverdueTasks } from "./overdueScan.js";
import { reconcileReminders } from "./reminderJobs.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// How long things are kept before the nightly clean-up removes them.
const ABANDONED_UPLOAD_DAYS = 1;
const PUBLISHED_EVENT_DAYS = 30;
const EXPORT_FILE_DAYS = 30;
const NOTIFICATION_DAYS = 180;
const USED_RESET_TOKEN_DAYS = 7;
const RAW_PAYLOAD_DAYS = 30;

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const today = () => new Date().toISOString().slice(0, 10);

const reportProblem = (message: string, details: object) => {
  logger.error(details, message);
  Sentry.captureMessage(message, { level: "error", extra: { ...details } });
};

// The nightly `npm run ledger:verify`. A problem goes to the logs and Sentry, and to the business's
// managers, who are the ones relying on those figures.
export const checkLedgers = async () => {
  const businesses = await prisma.business.findMany({ select: { id: true, workspaceId: true } });
  let problems = 0;

  for (const business of businesses) {
    const check = await reportsService.verifyBusiness(business.id);
    if (check.unbalancedEntries === 0 && check.accountsOutOfStep === 0 && check.rollupsOutOfStep === 0) continue;

    problems += 1;
    reportProblem("ledger check found a problem", check);
    const managers = await membersService.listUserIdsWithPermission(business.id, Permission.BUSINESS_MANAGE);
    await notificationsService.notify(
      managers.map((userId) => ({
        type: NotificationType.LEDGER_CHECK_FAILED,
        userId,
        workspaceId: business.workspaceId,
        businessId: business.id,
        params: {
          unbalancedEntries: check.unbalancedEntries,
          accountsOutOfStep: check.accountsOutOfStep,
          rollupsOutOfStep: check.rollupsOutOfStep,
        },
        dedupeKey: `${NotificationType.LEDGER_CHECK_FAILED}:${business.id}:${today()}:${userId}`,
      })),
    );
  }
  return { businesses: businesses.length, problems };
};

// The nightly `npm run audit:verify`. A broken chain means someone may have edited the audit log.
export const checkAuditChains = async () => {
  const results = await auditService.verifyAllChains();
  const broken = results.filter((result) => result.brokenAtId !== null);

  for (const result of broken) {
    reportProblem("audit chain is broken", result);
    if (!result.workspaceId) continue;

    const owners = await prisma.businessMember.findMany({
      where: { workspaceId: result.workspaceId, status: "ACTIVE", role: { key: "OWNER" } },
      select: { userId: true },
      distinct: ["userId"],
    });
    await notificationsService.notify(
      owners.map(({ userId }) => ({
        type: NotificationType.AUDIT_CHECK_FAILED,
        userId,
        workspaceId: result.workspaceId!,
        params: { brokenAtId: String(result.brokenAtId) },
        dedupeKey: `${NotificationType.AUDIT_CHECK_FAILED}:${result.workspaceId}:${today()}:${userId}`,
      })),
    );
  }
  return { chains: results.length, broken: broken.length };
};

const removeStoredFile = async (key: string) => {
  try {
    await deleteObject(key);
    return true;
  } catch (error) {
    // The row stays, so the next night tries again.
    logger.warn({ err: error, key }, "could not delete a stored file");
    return false;
  }
};

export const cleanUp = async () => {
  const idempotencyKeys = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const events = await prisma.outboxEvent.deleteMany({ where: { publishedAt: { lt: daysAgo(PUBLISHED_EVENT_DAYS) } } });
  const notifications = await prisma.notification.deleteMany({ where: { createdAt: { lt: daysAgo(NOTIFICATION_DAYS) } } });
  const resetTokens = await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: daysAgo(USED_RESET_TOKEN_DAYS) } } });
  const rawPayloads = await prisma.rawPayload.deleteMany({ where: { createdAt: { lt: daysAgo(RAW_PAYLOAD_DAYS) } } });

  // An upload that was started and never finished. Soft-deleted, like any other document.
  const uploads = await prisma.document.findMany({
    where: { status: "PENDING_UPLOAD", deletedAt: null, createdAt: { lt: daysAgo(ABANDONED_UPLOAD_DAYS) } },
    select: { id: true, storageKey: true },
  });
  let abandonedUploads = 0;
  for (const upload of uploads) {
    if (!(await removeStoredFile(upload.storageKey))) continue;
    await prisma.document.update({ where: { id: upload.id }, data: { deletedAt: new Date() } });
    abandonedUploads += 1;
  }

  // A report can always be exported again, and the audit log keeps the record that it was.
  const exportsToRemove = await prisma.reportExport.findMany({
    where: { createdAt: { lt: daysAgo(EXPORT_FILE_DAYS) } },
    select: { id: true, storageKey: true },
  });
  let exportFiles = 0;
  for (const row of exportsToRemove) {
    if (row.storageKey && !(await removeStoredFile(row.storageKey))) continue;
    await prisma.reportExport.delete({ where: { id: row.id } });
    exportFiles += 1;
  }

  return {
    idempotencyKeys: idempotencyKeys.count,
    events: events.count,
    notifications: notifications.count,
    resetTokens: resetTokens.count,
    rawPayloads: rawPayloads.count,
    abandonedUploads,
    exportFiles,
  };
};

// Every timed job. The times are for Bangladesh, when the system is quietest.
const TIMEZONE = "Asia/Dhaka";
const MAINTENANCE_JOBS: Record<string, { pattern: string; run: () => Promise<unknown> }> = {
  "reminders.reconcile": {
    pattern: "*/5 * * * *",
    run: async () => ({ reminders: await reconcileReminders(), deliveries: await requeueStuckDeliveries() }),
  },
  "recurring.run-due": { pattern: "*/5 * * * *", run: () => recurringSchedulesService.runAllDue() },
  "tasks.overdue-scan": { pattern: "*/15 * * * *", run: scanOverdueTasks },
  "integrations.sync-due": { pattern: "*/15 * * * *", run: queueDueSyncs },
  "statement-lines.settle": { pattern: "*/15 * * * *", run: () => statementLinesService.settlePendingLinks() },
  "ledger.verify": { pattern: "0 2 * * *", run: checkLedgers },
  "audit.verify": { pattern: "30 2 * * *", run: checkAuditChains },
  "system.clean-up": { pattern: "0 3 * * *", run: cleanUp },
};

// Safe to repeat on every start: it updates each timer rather than adding another.
export const registerMaintenanceJobs = () =>
  Promise.all(
    Object.entries(MAINTENANCE_JOBS).map(([name, { pattern }]) =>
      queues[QueueName.MAINTENANCE].upsertJobScheduler(name, { pattern, tz: TIMEZONE }, { name }),
    ),
  );

// After Redis comes back empty, puts the jobs back straight away rather than at the next timer.
export const startCatchUp = () => queues[QueueName.MAINTENANCE].add("reminders.reconcile", {});

export const runMaintenanceJob = async (name: string) => {
  const result = await MAINTENANCE_JOBS[name]?.run();
  logger.info({ job: name, result }, "maintenance job finished");
  return result;
};
