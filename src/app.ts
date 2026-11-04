import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { env, isProduction } from "./app/config/env.config.js";
import { buildOpenApiDocument } from "./app/docs/openapi.js";
import { errorHandler, notFound } from "./app/middlewares/errorHandler.js";
import { rateLimit } from "./app/middlewares/rateLimit.js";
import { requestId } from "./app/middlewares/requestId.js";
import { requestLogger } from "./app/middlewares/requestLogger.js";
import apiRoutes from "./app/routes/index.js";
import { bigintToString } from "./app/utils/money.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { checkStorage } from "./lib/storage.js";

const app = express();

app.set("trust proxy", env.TRUST_PROXY);
// Money is BIGINT, and JSON has no BIGINT: it travels as an integer string.
app.set("json replacer", bigintToString);
app.use(requestId);
app.use(requestLogger);

app.get("/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok" } });
});

app.get("/health/ready", async (_req, res) => {
  const check = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
      return true;
    } catch (error) {
      logger.error({ err: error, dependency: name }, "readiness check failed");
      return false;
    }
  };
  const [database, cache, storage] = await Promise.all([
    check("database", () => prisma.$queryRaw`SELECT 1`),
    check("redis", () => redis.ping()),
    check("storage", checkStorage),
  ]);
  const ready = database && cache && storage;
  res.status(ready ? 200 : 503).json({ success: ready, data: { database, redis: cache, storage } });
});

// Registered before helmet because Swagger UI needs inline styles. Never served in production.
if (!isProduction) {
  const document = buildOpenApiDocument();
  app.get("/api/docs/openapi.json", (_req, res) => {
    res.json(document);
  });
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(document));
}

// Registered before helmet because this admin screen needs inline scripts. Off unless a password is set.
if (env.BULL_BOARD_PASSWORD) {
  const { queueBoard } = await import("./app/admin/queueBoard.js");
  app.use("/admin/queues", rateLimit({ name: "queue-board", windowSeconds: 60, max: 120 }), queueBoard());
}

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS, credentials: true, exposedHeaders: ["X-Request-Id"] }));
app.use(rateLimit({ name: "global", windowSeconds: 60, max: 300 }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use("/api/v1", apiRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
