import { pino } from "pino";
import { env } from "../app/config/env.config.js";

const sensitiveKeys = [
  "password",
  "currentPassword",
  "newPassword",
  "passwordHash",
  "authorization",
  "cookie",
  "token",
  "accessToken",
  "refreshToken",
  "challengeToken",
  "csrfToken",
  "otp",
  "secret",
  "encryptedSecret",
  "pin",
];

export const redactPaths = [
  ...sensitiveKeys,
  ...sensitiveKeys.map((key) => `*.${key}`),
  // Only the request body's MFA code: a wider "*.code" would also hide database error codes.
  "body.code",
  "req.body.code",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: "[REDACTED]" },
  ...(env.NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { singleLine: true } } }
    : {}),
});

// Login failures, MFA failures and token reuse. Alerts can filter on channel = security.
export const securityLogger = logger.child({ channel: "security" });
