import * as Sentry from "@sentry/node";
import app from "./app.js";
import { env } from "./app/config/env.config.js";
import { shutdownTelemetry } from "./instrument.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";

await prisma.$connect();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "API listening");
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");

  // Stop taking requests, let running ones finish, then close dependencies.
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  redis.disconnect();
  await Sentry.close(2000);
  await shutdownTelemetry().catch(() => {});
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled rejection");
  Sentry.captureException(reason);
});
