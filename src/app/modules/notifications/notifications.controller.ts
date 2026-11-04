import type { RequestHandler, Response } from "express";
import { env } from "../../config/env.config.js";
import { countStreams, subscribeToUser } from "../../../lib/realtime.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  IListNotificationsQuery,
  INotificationParams,
  IPushSubscribeBody,
  ISubscriptionParams,
  IUpdatePreferencesBody,
} from "./notifications.interface.js";
import { notificationsService } from "./notifications.service.js";

const HEARTBEAT_MS = 25_000;
const MAX_STREAMS_PER_USER = 5;

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await notificationsService.list(req.auth!.userId, req.validated.query as IListNotificationsQuery));
};

const unreadCount: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await notificationsService.unreadCount(req.auth!.userId));
};

const markRead: RequestHandler = async (req, res) => {
  const { notificationId } = req.validated.params as INotificationParams;
  sendResponse(res, 200, await notificationsService.markRead(req.auth!.userId, notificationId));
};

const markAllRead: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await notificationsService.markAllRead(req.auth!.userId));
};

const listDeliveries: RequestHandler = async (req, res) => {
  const { notificationId } = req.validated.params as INotificationParams;
  sendResponse(res, 200, await notificationsService.listDeliveries(req.auth!.userId, notificationId));
};

const getPreferences: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await notificationsService.getPreferences(req.auth!.userId));
};

const updatePreferences: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await notificationsService.updatePreferences(req.auth!.userId, req.validated.body as IUpdatePreferencesBody));
};

const getPushConfig: RequestHandler = (_req, res) => {
  sendResponse(res, 200, notificationsService.getPushConfig());
};

const subscribePush: RequestHandler = async (req, res) => {
  const userAgent = req.get("user-agent")?.slice(0, 512) ?? null;
  sendResponse(res, 201, await notificationsService.subscribePush(req.auth!.userId, req.validated.body as IPushSubscribeBody, userAgent));
};

const listPushSubscriptions: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await notificationsService.listPushSubscriptions(req.auth!.userId));
};

const removePushSubscription: RequestHandler = async (req, res) => {
  const { subscriptionId } = req.validated.params as ISubscriptionParams;
  sendResponse(res, 200, await notificationsService.removePushSubscription(req.auth!.userId, subscriptionId));
};

const writeEvent = (res: Response, event: string, data: string) => {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
};

// Server-Sent Events. Sent with the normal Bearer header, so it stops when that token's life ends;
// the browser reconnects with a fresh one. A signed-out user therefore can't keep listening.
const stream: RequestHandler = (req, res) => {
  const { userId } = req.auth!;
  if (countStreams(userId) >= MAX_STREAMS_PER_USER) throw new AppError(429, ErrorCode.RATE_LIMITED);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Stops nginx holding messages back in a buffer.
    "X-Accel-Buffering": "no",
  });
  writeEvent(res, "connected", "{}");

  const unsubscribe = subscribeToUser(userId, (message) => writeEvent(res, "notification", message));
  // A comment line keeps proxies from closing a quiet connection.
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);
  const expiry = setTimeout(() => res.end(), env.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000);

  res.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(expiry);
    unsubscribe();
  });
};

export const notificationsController = {
  list,
  unreadCount,
  markRead,
  markAllRead,
  listDeliveries,
  getPreferences,
  updatePreferences,
  getPushConfig,
  subscribePush,
  listPushSubscriptions,
  removePushSubscription,
  stream,
};
