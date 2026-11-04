import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { RequestHandler } from "express";
import { Router } from "express";
import { env } from "../config/env.config.js";
import { queues } from "../../lib/queues.js";
import { securityLogger } from "../../lib/logger.js";
import { safeEqual } from "../utils/crypto.js";

const USERNAME = "admin";
const BASE_PATH = "/admin/queues";

// A plain password rather than a user role: queues hold every business's jobs, so this screen belongs
// to whoever runs the server, not to any one business. Always serve it over HTTPS.
const requirePassword: RequestHandler = (req, res, next) => {
  const [scheme, encoded] = (req.get("authorization") ?? "").split(" ");
  const [username, ...rest] = Buffer.from(encoded ?? "", "base64").toString("utf8").split(":");
  const passwordMatches = safeEqual(rest.join(":"), env.BULL_BOARD_PASSWORD!);

  if (scheme === "Basic" && username === USERNAME && passwordMatches) return next();

  if (encoded) securityLogger.warn({ ip: req.ip }, "queue board sign-in failed");
  res.set("WWW-Authenticate", 'Basic realm="Business OS queues"').status(401).end();
};

export const queueBoard = () => {
  const adapter = new ExpressAdapter();
  adapter.setBasePath(BASE_PATH);
  createBullBoard({
    queues: Object.values(queues).map((queue) => new BullMQAdapter(queue)),
    serverAdapter: adapter,
  });
  return Router().use(requirePassword, adapter.getRouter() as RequestHandler);
};
