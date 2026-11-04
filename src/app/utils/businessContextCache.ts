import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import type { BusinessContext } from "../modules/members/members.interface.js";

const TTL_SECONDS = 60;
const keyFor = (businessId: string) => `business-context:${businessId}`;

// One Redis hash per business, so a role or status change can clear the whole business at once.
// All three helpers fail open: without Redis, the context simply comes from the database.
const attempt = async <T>(operation: () => Promise<T>, fallback: T) => {
  try {
    return await operation();
  } catch (error) {
    logger.warn({ err: error }, "business context cache skipped: redis unavailable");
    return fallback;
  }
};

export const readCachedContext = (businessId: string, userId: string) =>
  attempt(async () => {
    const cached = await redis.hget(keyFor(businessId), userId);
    return cached ? (JSON.parse(cached) as BusinessContext) : null;
  }, null);

export const cacheContext = (context: BusinessContext) =>
  attempt(async () => {
    const key = keyFor(context.businessId);
    await redis.hset(key, context.userId, JSON.stringify(context));
    // NX keeps the first expiry, so nothing lives longer than 60s after the hash was created.
    await redis.expire(key, TTL_SECONDS, "NX");
  }, undefined);

// Call after the transaction commits.
export const invalidateBusinessContext = (businessId: string) => attempt(() => redis.del(keyFor(businessId)), 0);
