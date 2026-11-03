import { pinoHttp } from "pino-http";
import { logger } from "../../lib/logger.js";

export const requestLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as unknown as { requestId: string }).requestId,
  customLogLevel: (_req, res, error) => {
    if (error || res.statusCode >= 500) return "error";
    return res.statusCode >= 400 ? "warn" : "info";
  },
  customProps: (req) => {
    const auth = (req as unknown as { auth?: { userId: string } }).auth;
    return { request_id: (req as unknown as { requestId: string }).requestId, user_id: auth?.userId };
  },
  autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
});
