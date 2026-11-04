import * as Sentry from "@sentry/node";
import { Worker } from "bullmq";
import { ingestionService } from "./app/ai/ingestion.js";
import { relayDeliveries } from "./app/jobs/deliveryRelay.js";
import type { EventJob } from "./app/jobs/eventTypes.js";
import { registerMaintenanceJobs, runMaintenanceJob, startCatchUp } from "./app/jobs/maintenance.js";
import { relayOutbox } from "./app/jobs/outboxRelay.js";
import { processEvent } from "./app/jobs/processEvent.js";
import { fireReminder, type ReminderJob } from "./app/jobs/reminderJobs.js";
import { notificationsService } from "./app/modules/notifications/notifications.service.js";
import { statementImportsService } from "./app/modules/statement-imports/statement-imports.service.js";
import { reportExportsService } from "./app/modules/report-exports/report-exports.service.js";
import { shutdownTelemetry } from "./instrument.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { queueConnection, QueueName, queues } from "./lib/queues.js";
import { redis } from "./lib/redis.js";
import { ensureBucket } from "./lib/storage.js";

// The background process: same codebase as the API, started with `npm run worker`.
const RELAY_INTERVAL_MS = 2000;
const TIMER_CHECK_INTERVAL_MS = 60_000;

await prisma.$connect();
await ensureBucket().catch((error) => logger.error({ err: error }, "storage bucket check failed"));

const workers = [
  new Worker<EventJob>(QueueName.LEDGER_EVENTS, (job) => processEvent(job.data), { connection: queueConnection, concurrency: 5 }),
  // Each PDF runs a browser, so these go one at a time.
  new Worker<EventJob>(QueueName.REPORT_EXPORTS, (job) => processEvent(job.data), { connection: queueConnection, concurrency: 1 }),
  new Worker<EventJob>(QueueName.DOMAIN_EVENTS, (job) => processEvent(job.data), { connection: queueConnection, concurrency: 5 }),
  new Worker<ReminderJob>(QueueName.REMINDERS, (job) => fireReminder(job.data), { connection: queueConnection, concurrency: 5 }),
  new Worker<{ deliveryId: string }>(QueueName.NOTIFICATIONS, (job) => notificationsService.sendDelivery(job.data.deliveryId), {
    connection: queueConnection,
    concurrency: 5,
  }),
  // One at a time: reading a long scan and working out its meaning uses a lot of memory.
  new Worker<EventJob>(QueueName.DOCUMENTS, (job) => processEvent(job.data), { connection: queueConnection, concurrency: 1 }),
  // Provider limits are per connection, and a claim stops one connection syncing twice at once.
  new Worker<EventJob>(QueueName.INTEGRATIONS, (job) => processEvent(job.data), { connection: queueConnection, concurrency: 3 }),
  // One at a time, so a long nightly check can't overlap with itself.
  new Worker(QueueName.MAINTENANCE, (job) => runMaintenanceJob(job.name), { connection: queueConnection, concurrency: 1 }),
];

for (const worker of workers) {
  worker.on("completed", (job) => logger.info({ queue: worker.name, job_id: job.id, type: job.name }, "job finished"));
  worker.on("failed", (job, error) => {
    logger.error({ queue: worker.name, job_id: job?.id, attempts: job?.attemptsMade, err: error }, "job failed");

    const isFinalAttempt = job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isFinalAttempt) return;
    Sentry.captureException(error, { tags: { queue: worker.name, job_id: job.id ?? "unknown" } });
    if (worker.name === QueueName.REPORT_EXPORTS && job.data.payload.exportId) {
      void reportExportsService.markFailed(job.data.payload.exportId);
    }
    if (worker.name === QueueName.NOTIFICATIONS) void notificationsService.markDeliveryFailed(job.data.deliveryId);
    if (worker.name === QueueName.DOCUMENTS && job.data.payload.documentId) void ingestionService.markFailed(job.data.payload.documentId);
    if (worker.name === QueueName.INTEGRATIONS && job.data.payload.importId) void statementImportsService.markFailed(job.data.payload.importId);
  });
}

let relayRunning = false;
const relayTimer = setInterval(() => {
  if (relayRunning) return;
  relayRunning = true;
  Promise.all([relayOutbox(), relayDeliveries()])
    .catch((error) => logger.error({ err: error }, "relay failed, will retry"))
    .finally(() => {
      relayRunning = false;
    });
}, RELAY_INTERVAL_MS);

// The timers themselves live in Redis, so emptying it would stop the reconciler that repairs
// everything else. Checking them often means it puts itself back.
await registerMaintenanceJobs();
await startCatchUp();
const timerCheck = setInterval(() => {
  void (async () => {
    const before = await queues[QueueName.MAINTENANCE].getJobSchedulersCount();
    await registerMaintenanceJobs();
    if (before === 0) {
      logger.warn("maintenance timers were missing from Redis, so they were restored");
      await startCatchUp();
    }
  })().catch((error) => logger.error({ err: error }, "could not check maintenance timers"));
}, TIMER_CHECK_INTERVAL_MS);

logger.info("worker started");

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutting down");

  clearInterval(relayTimer);
  clearInterval(timerCheck);
  // Finishes running jobs. Anything unfinished is retried by the next worker.
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await prisma.$disconnect();
  redis.disconnect();
  await Sentry.close(2000);
  await shutdownTelemetry().catch(() => {});
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
