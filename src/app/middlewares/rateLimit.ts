import type { RequestHandler } from "express";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { AppError, ErrorCode } from "../utils/errors.js";

// Atomic, so a crash can never leave a counter without an expiry.
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
`;

interface RateLimitOptions {
  name: string;
  windowSeconds: number;
  max: number;
  // "user" needs the auth middleware to run first.
  by?: "ip" | "user";
}

export const rateLimit = ({ name, windowSeconds, max, by = "ip" }: RateLimitOptions): RequestHandler => {
  return async (req, res, next) => {
    const subject = by === "user" ? (req.auth?.userId ?? req.ip) : req.ip;

    let count: number;
    let ttlMs: number;
    try {
      [count, ttlMs] = (await redis.eval(
        INCREMENT_SCRIPT,
        1,
        `ratelimit:${name}:${subject}`,
        windowSeconds * 1000,
      )) as [number, number];
    } catch (error) {
      // Fail open: a Redis outage should degrade protection, not take the API down.
      logger.warn({ err: error, limiter: name }, "rate limit skipped: redis unavailable");
      return next();
    }

    const retryAfterSeconds = Math.max(Math.ceil(ttlMs / 1000), 1);
    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", Math.max(max - count, 0));
    res.setHeader("RateLimit-Reset", retryAfterSeconds);

    if (count > max) {
      return next(new AppError(429, ErrorCode.RATE_LIMITED, { retryAfterSeconds }));
    }
    next();
  };
};
