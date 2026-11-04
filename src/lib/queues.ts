import { Queue } from "bullmq";
import { env } from "../app/config/env.config.js";

export const QueueName = {
  LEDGER_EVENTS: "ledger-events",
  REPORT_EXPORTS: "report-exports",
  DOMAIN_EVENTS: "domain-events",
  REMINDERS: "reminders",
  NOTIFICATIONS: "notifications",
  MAINTENANCE: "maintenance",
  INTEGRATIONS: "integrations",
  DOCUMENTS: "documents",
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

const url = new URL(env.REDIS_URL);

// BullMQ needs its own connection settings, separate from src/lib/redis.ts: a worker must wait
// through a Redis outage, whereas API requests must fail fast.
export const queueConnection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  db: Number(url.pathname.slice(1) || 0),
  ...(url.username ? { username: url.username } : {}),
  ...(url.password ? { password: url.password } : {}),
  maxRetriesPerRequest: null,
};

// Failed jobs stay visible for inspection. That failed set is the dead-letter queue.
const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export const queues = {
  [QueueName.LEDGER_EVENTS]: new Queue(QueueName.LEDGER_EVENTS, { connection: queueConnection, defaultJobOptions }),
  [QueueName.REPORT_EXPORTS]: new Queue(QueueName.REPORT_EXPORTS, {
    connection: queueConnection,
    // A PDF needs a browser, so failed exports retry fewer times.
    defaultJobOptions: { ...defaultJobOptions, attempts: 3 },
  }),
  [QueueName.DOMAIN_EVENTS]: new Queue(QueueName.DOMAIN_EVENTS, { connection: queueConnection, defaultJobOptions }),
  [QueueName.REMINDERS]: new Queue(QueueName.REMINDERS, { connection: queueConnection, defaultJobOptions }),
  [QueueName.NOTIFICATIONS]: new Queue(QueueName.NOTIFICATIONS, { connection: queueConnection, defaultJobOptions }),
  // Reading a long scan is slow and uses a lot of memory, so these retry fewer times.
  [QueueName.DOCUMENTS]: new Queue(QueueName.DOCUMENTS, { connection: queueConnection, defaultJobOptions: { ...defaultJobOptions, attempts: 3 } }),
  // Jitter stops many failed syncs retrying against a provider at the same moment.
  [QueueName.INTEGRATIONS]: new Queue(QueueName.INTEGRATIONS, {
    connection: queueConnection,
    defaultJobOptions: { ...defaultJobOptions, backoff: { type: "exponential" as const, delay: 5000, jitter: 0.5 } },
  }),
  // These run again on their next schedule, so a failure is not worth retrying at once.
  [QueueName.MAINTENANCE]: new Queue(QueueName.MAINTENANCE, {
    connection: queueConnection,
    defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
  }),
};
