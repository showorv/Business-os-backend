import * as Sentry from "@sentry/node";
import { Worker } from "bullmq";
import type { EventJob } from "./app/jobs/eventTypes.js";
import { relayOutbox } from "./app/jobs/outboxRelay.js";
import { processEvent } from "./app/jobs/processEvent.js";
import { reportExportsService } from "./app/modules/report-exports/report-exports.service.js";
import { shutdownTelemetry } from "./instrument.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { queueConnection, QueueName, queues } from "./lib/queues.js";
import { redis } from "./lib/redis.js";
import { ensureBucket } from "./lib/storage.js";

// The background process: same codebase as the API, started with `npm run worker`.
const RELAY_INTERVAL_MS = 2000;

await prisma.$connect();
await ensureBucket().catch((error) => logger.error({ err: error }, "storage bucket check failed"));

const workers = [
  new Worker<EventJob>(QueueName.LEDGER_EVENTS, (job) => processEvent(job.data), { connection: queueConnection, concurrency: 5 }),
  // Each PDF runs a browser, so these go one at a time.
  new Worker<EventJob>(QueueName.REPORT_EXPORTS, (job) => processEvent(job.data), { connection: queueConnection, concurrency: 1 }),
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
  });
}

let relayRunning = false;
const relayTimer = setInterval(() => {
  if (relayRunning) return;
  relayRunning = true;
  relayOutbox()
    .catch((error) => logger.error({ err: error }, "outbox relay failed, will retry"))
    .finally(() => {
      relayRunning = false;
    });
}, RELAY_INTERVAL_MS);

logger.info("worker started");

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutting down");

  clearInterval(relayTimer);
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
