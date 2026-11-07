import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { logger } from "../../../lib/logger.js";
import { emailEnabled, sendEmail } from "../../../lib/mailer.js";
import { publishToUser } from "../../../lib/realtime.js";
import { withRls } from "../../../lib/rls.js";
import { pushEnabled, pushPublicKey, sendPush } from "../../../lib/webPush.js";
import { renderNotification, type Locale } from "../../notifications/templates.js";
import { decryptSecret } from "../../utils/crypto.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import { toWallClock } from "../../utils/rrule.js";
import {
  NotificationType,
  type IListNotificationsQuery,
  type IPushSubscribeBody,
  type IUpdatePreferencesBody,
  type NotificationChannel,
  type NotificationInput,
  type NotificationParams,
} from "./notifications.interface.js";

const ALL_CHANNELS: NotificationChannel[] = ["IN_APP", "EMAIL", "PUSH"];

const DEFAULT_PREFERENCES = {
  emailEnabled: true,
  pushEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: "Asia/Dhaka",
};

// Which channels each type uses when the caller doesn't choose.
const CHANNELS_BY_TYPE: Partial<Record<NotificationType, NotificationChannel[]>> = {
  [NotificationType.EXPORT_READY]: ["IN_APP"],
  [NotificationType.EXPORT_FAILED]: ["IN_APP"],
  [NotificationType.STATEMENT_IMPORT_FINISHED]: ["IN_APP"],
  [NotificationType.INVITATION]: ["EMAIL"],
  [NotificationType.PASSWORD_RESET]: ["EMAIL"],
  [NotificationType.PASSWORD_CHANGED]: ["EMAIL"],
  [NotificationType.ACCOUNT_LOCKED]: ["EMAIL"],
  [NotificationType.SESSION_REUSE_DETECTED]: ["EMAIL"],
};

// These go out at once and ignore preferences: a password link is no use eight hours later, and
// nobody should be able to turn off being told their account is under attack.
const ALWAYS_SENT = new Set<string>([
  NotificationType.INVITATION,
  NotificationType.PASSWORD_RESET,
  NotificationType.PASSWORD_CHANGED,
  NotificationType.ACCOUNT_LOCKED,
  NotificationType.SESSION_REUSE_DETECTED,
  NotificationType.LEDGER_CHECK_FAILED,
  NotificationType.AUDIT_CHECK_FAILED,
]);

const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
};

// When email and push may go out: now, or the end of the reader's quiet hours.
export const sendAfterQuietHours = (
  preferences: { quietHoursStart: string | null; quietHoursEnd: string | null; timezone: string },
  now: Date,
) => {
  if (!preferences.quietHoursStart || !preferences.quietHoursEnd) return now;

  const wall = toWallClock(now, preferences.timezone);
  const current = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  const start = minutesOf(preferences.quietHoursStart);
  const end = minutesOf(preferences.quietHoursEnd);

  // 22:00 to 08:00 runs across midnight.
  const inQuietHours = start <= end ? current >= start && current < end : current >= start || current < end;
  if (!inQuietHours) return now;

  const minutesLeft = (end - current + 24 * 60) % (24 * 60);
  return new Date(now.getTime() + minutesLeft * 60 * 1000);
};

// Saves notifications and how each channel will be delivered, in the caller's transaction. The worker
// sends them afterwards, so nothing is lost if the mail server or Redis is down.
const dispatch = async (tx: Prisma.TransactionClient, inputs: NotificationInput[]) => {
  if (inputs.length === 0) return [];

  const userIds = [...new Set(inputs.flatMap((input) => (input.userId ? [input.userId] : [])))];
  const [activeUsers, preferences, subscriptions] = await Promise.all([
    tx.user.findMany({ where: { id: { in: userIds }, status: "ACTIVE" }, select: { id: true } }),
    tx.notificationPreference.findMany({ where: { userId: { in: userIds } } }),
    tx.pushSubscription.findMany({ where: { userId: { in: userIds } }, select: { userId: true } }),
  ]);
  const activeIds = new Set(activeUsers.map((user) => user.id));
  const preferencesByUser = new Map(preferences.map((row) => [row.userId, row]));
  const hasPush = new Set(subscriptions.map((row) => row.userId));

  const wanted = inputs.filter((input) => (input.userId ? activeIds.has(input.userId) : Boolean(input.email)));
  // Skipping duplicates is what makes a job safe to run twice.
  const created = await tx.notification.createManyAndReturn({
    data: wanted.map(({ channels: _channels, ...input }) => input as Prisma.NotificationCreateManyInput),
    skipDuplicates: true,
  });

  const now = new Date();
  const inputByKey = new Map(wanted.map((input) => [input.dedupeKey, input]));
  const deliveries = created.flatMap((notification) => {
    const input = inputByKey.get(notification.dedupeKey)!;
    const channels = input.channels ?? CHANNELS_BY_TYPE[input.type] ?? ALL_CHANNELS;
    const userPreferences = (notification.userId && preferencesByUser.get(notification.userId)) || DEFAULT_PREFERENCES;
    const alwaysSent = ALWAYS_SENT.has(notification.type);

    return channels.map((channel): Prisma.NotificationDeliveryCreateManyInput => {
      const base = { notificationId: notification.id, userId: notification.userId, channel };

      if (channel === "IN_APP") return { ...base, status: "SENT", sentAt: now };
      if (channel === "EMAIL" && !alwaysSent && !userPreferences.emailEnabled) {
        return { ...base, status: "SKIPPED", lastErrorCode: "DISABLED_BY_USER" };
      }
      if (channel === "PUSH" && !userPreferences.pushEnabled) return { ...base, status: "SKIPPED", lastErrorCode: "DISABLED_BY_USER" };
      if (channel === "PUSH" && !hasPush.has(notification.userId ?? "")) return { ...base, status: "SKIPPED", lastErrorCode: "NO_SUBSCRIPTION" };

      return { ...base, sendAfter: alwaysSent ? now : sendAfterQuietHours(userPreferences, now) };
    });
  });
  await tx.notificationDelivery.createMany({ data: deliveries });

  return created.filter((notification) =>
    deliveries.some((delivery) => delivery.notificationId === notification.id && delivery.channel === "IN_APP"),
  );
};

type StoredNotification = Awaited<ReturnType<typeof dispatch>>[number];

const toDto = (notification: Omit<StoredNotification, "userId" | "email" | "locale" | "workspaceId" | "dedupeKey">) => ({
  id: notification.id,
  type: notification.type,
  params: notification.params,
  businessId: notification.businessId,
  entityType: notification.entityType,
  entityId: notification.entityId,
  readAt: notification.readAt,
  createdAt: notification.createdAt,
});

// Tells any open browser tabs. Call after the transaction that saved them has committed.
const publishInApp = async (notifications: StoredNotification[]) => {
  await Promise.all(
    notifications.map((notification) => (notification.userId ? publishToUser(notification.userId, toDto(notification)) : undefined)),
  );
};

const notify = async (inputs: NotificationInput[]) => {
  const created = await prisma.$transaction((tx) => dispatch(tx, inputs));
  await publishInApp(created);
};

// For a request that must not fail because a notification couldn't be saved.
const notifySafely = async (inputs: NotificationInput[]) => {
  try {
    await notify(inputs);
  } catch (error) {
    logger.error({ err: error, types: inputs.map((input) => input.type) }, "could not save notification");
  }
};

// ---------------------------------------------------------------------------
// The person's own notifications. Row-Level Security limits all of these to their rows.
// ---------------------------------------------------------------------------
const ownScope = (userId: string) => ({ userId, businessIds: [] });

const inAppOnly = { deliveries: { some: { channel: "IN_APP" as const } } };

const list = async (userId: string, query: IListNotificationsQuery) => {
  const rows = await withRls(ownScope(userId), (tx) =>
    tx.notification.findMany({
      where: { userId, ...inAppOnly, ...(query.unreadOnly ? { readAt: null } : {}) },
      orderBy: { id: "desc" },
      ...pageArgs(query),
    }),
  );
  const page = toPage(rows, query.limit);
  return { items: page.items.map(toDto), nextCursor: page.nextCursor };
};

const unreadCount = async (userId: string) => ({
  count: await withRls(ownScope(userId), (tx) => tx.notification.count({ where: { userId, readAt: null, ...inAppOnly } })),
});

const markRead = (userId: string, notificationId: string) =>
  withRls(ownScope(userId), async (tx) => {
    const { count } = await tx.notification.updateMany({
      where: { id: notificationId, userId, ...inAppOnly, readAt: null },
      data: { readAt: new Date() },
    });
    const notification = await tx.notification.findFirst({ where: { id: notificationId, userId, ...inAppOnly } });
    if (!notification) throw new AppError(404, ErrorCode.NOT_FOUND);
    return { ...toDto(notification), changed: count > 0 };
  });

const markAllRead = async (userId: string) => {
  const { count } = await withRls(ownScope(userId), (tx) =>
    tx.notification.updateMany({ where: { userId, readAt: null, ...inAppOnly }, data: { readAt: new Date() } }),
  );
  return { marked: count };
};

// What happened to each channel, so the app can show why an email never arrived.
const listDeliveries = (userId: string, notificationId: string) =>
  withRls(ownScope(userId), async (tx) => {
    const notification = await tx.notification.findFirst({ where: { id: notificationId, userId, ...inAppOnly }, select: { id: true } });
    if (!notification) throw new AppError(404, ErrorCode.NOT_FOUND);
    return tx.notificationDelivery.findMany({
      where: { notificationId },
      orderBy: { channel: "asc" },
      select: { channel: true, status: true, attempts: true, lastErrorCode: true, sendAfter: true, sentAt: true },
    });
  });

const getPreferences = async (userId: string) => {
  const row = await withRls(ownScope(userId), (tx) => tx.notificationPreference.findUnique({ where: { userId } }));
  return row ?? { userId, ...DEFAULT_PREFERENCES };
};

const updatePreferences = (userId: string, body: IUpdatePreferencesBody) =>
  withRls(ownScope(userId), (tx) =>
    tx.notificationPreference.upsert({ where: { userId }, create: { userId, ...body }, update: body }),
  );

const getPushConfig = () => ({ enabled: pushEnabled(), publicKey: pushPublicKey() });

// One browser belongs to whoever signed in last, so this may take the row over from another user.
// That needs to see their row, so it runs on the normal connection.
const subscribePush = async (userId: string, body: IPushSubscribeBody, userAgent: string | null) => {
  if (!pushEnabled()) throw new AppError(409, ErrorCode.PUSH_NOT_CONFIGURED);

  const values = { userId, p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent };
  const subscription = await prisma.pushSubscription.upsert({
    where: { endpoint: body.endpoint },
    create: { endpoint: body.endpoint, ...values },
    update: values,
  });
  return { id: subscription.id, createdAt: subscription.createdAt };
};

const listPushSubscriptions = (userId: string) =>
  withRls(ownScope(userId), (tx) =>
    tx.pushSubscription.findMany({ where: { userId }, select: { id: true, userAgent: true, createdAt: true } }),
  );

const removePushSubscription = (userId: string, subscriptionId: string) =>
  withRls(ownScope(userId), async (tx) => {
    const { count } = await tx.pushSubscription.deleteMany({ where: { id: subscriptionId, userId } });
    if (count === 0) throw new AppError(404, ErrorCode.NOT_FOUND);
    return { removed: true };
  });

// ---------------------------------------------------------------------------
// Sending. These run in the worker.
// ---------------------------------------------------------------------------

// Secret links travel encrypted. Only here, just before sending, are they decrypted.
const withDecryptedToken = (notification: { params: unknown; entityId: string | null }) => {
  const { tokenEncrypted, ...params } = notification.params as NotificationParams;
  return typeof tokenEncrypted === "string"
    ? { ...params, token: decryptSecret(tokenEncrypted, notification.entityId!) }
    : params;
};

const skip = (deliveryId: string, code: string) =>
  prisma.notificationDelivery.update({ where: { id: deliveryId }, data: { status: "SKIPPED", lastErrorCode: code } });

const sendDelivery = async (deliveryId: string) => {
  const delivery = await prisma.notificationDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      notification: { include: { user: { select: { email: true, locale: true, digitStyle: true, status: true } } } },
    },
  });
  // A job can run twice, and a send already finished must not go out again.
  if (!delivery || ["SENT", "SKIPPED", "FAILED"].includes(delivery.status)) return;

  const { notification } = delivery;
  if (notification.user && notification.user.status !== "ACTIVE") return void (await skip(deliveryId, "USER_DISABLED"));

  await prisma.notificationDelivery.update({ where: { id: deliveryId }, data: { attempts: { increment: 1 } } });

  const business = notification.businessId
    ? await prisma.business.findUnique({ where: { id: notification.businessId }, select: { name: true, settings: true } })
    : null;
  const content = renderNotification(notification.type as NotificationType, withDecryptedToken(notification), {
    locale: (notification.user?.locale ?? notification.locale ?? "en") as Locale,
    digitStyle: (notification.user?.digitStyle ?? "latin") as "latin" | "bangla",
    grouping: (business?.settings as { numberGrouping?: "lakh" | "western" } | undefined)?.numberGrouping ?? "lakh",
    businessName: business?.name ?? null,
    businessId: notification.businessId,
  });

  try {
    if (delivery.channel === "EMAIL") {
      if (!emailEnabled()) return void (await skip(deliveryId, "EMAIL_NOT_CONFIGURED"));
      const to = notification.user?.email ?? notification.email;
      await sendEmail({ to: to!, subject: content.subject, text: content.text, html: content.html });
    }

    if (delivery.channel === "PUSH") {
      if (!pushEnabled()) return void (await skip(deliveryId, "PUSH_NOT_CONFIGURED"));
      const targets = await prisma.pushSubscription.findMany({ where: { userId: notification.userId ?? "" } });
      if (targets.length === 0) return void (await skip(deliveryId, "NO_SUBSCRIPTION"));

      const payload = { notificationId: notification.id, title: content.subject, body: content.text, url: content.url };
      for (const target of targets) {
        const stillSubscribed = await sendPush(target, payload);
        if (!stillSubscribed) await prisma.pushSubscription.deleteMany({ where: { id: target.id } });
      }
    }
  } catch (error) {
    const code = String((error as { code?: unknown; statusCode?: unknown }).code ?? (error as { statusCode?: unknown }).statusCode ?? "SEND_FAILED");
    await prisma.notificationDelivery.update({ where: { id: deliveryId }, data: { lastErrorCode: code.slice(0, 50) } });
    throw error;
  }

  await prisma.notificationDelivery.update({
    where: { id: deliveryId },
    data: { status: "SENT", sentAt: new Date(), lastErrorCode: null },
  });
};

// When retries run out.
const markDeliveryFailed = (deliveryId: string) =>
  prisma.notificationDelivery.update({ where: { id: deliveryId }, data: { status: "FAILED" } });

export const notificationsService = {
  dispatch,
  publishInApp,
  notify,
  notifySafely,
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
  sendDelivery,
  markDeliveryFailed,
};
