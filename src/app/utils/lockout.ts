import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { AppError, ErrorCode } from "./errors.js";

const MAX_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;

// Redis being down must not stop people logging in, so every helper here fails open.
const failOpen = async <T>(operation: () => Promise<T>, fallback: T) => {
  try {
    return await operation();
  } catch (error) {
    logger.warn({ err: error }, "lockout check skipped: redis unavailable");
    return fallback;
  }
};

export const assertNotLocked = async (key: string) => {
  const [count, ttl] = await failOpen(
    async () => Promise.all([redis.get(`lockout:${key}`), redis.ttl(`lockout:${key}`)]),
    [null, -1] as [string | null, number],
  );
  if (Number(count) >= MAX_FAILURES) {
    throw new AppError(429, ErrorCode.ACCOUNT_LOCKED, { retryAfterSeconds: Math.max(ttl, 1) });
  }
};

// Says whether this failure is the one that locked the account.
export const recordFailure = (key: string) =>
  failOpen(async () => {
    const count = await redis.incr(`lockout:${key}`);
    if (count === 1) await redis.expire(`lockout:${key}`, LOCK_SECONDS);
    return count === MAX_FAILURES;
  }, false);

export const clearFailures = (key: string) => failOpen(() => redis.del(`lockout:${key}`), 0);
