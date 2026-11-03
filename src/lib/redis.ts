import { Redis } from "ioredis";
import { env } from "../app/config/env.config.js";
import { logger } from "./logger.js";

// No offline queue and a short timeout: when Redis is down, commands reject at once, so requests
// fail open (see rateLimit and lockout) instead of waiting on a reconnect.
export const redis = new Redis(env.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 1000,
});

let lastErrorLoggedAt = 0;
redis.on("error", (error) => {
  if (Date.now() - lastErrorLoggedAt > 30_000) {
    lastErrorLoggedAt = Date.now();
    logger.error({ err: error }, "redis connection error");
  }
});
