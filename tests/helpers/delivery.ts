import { prisma } from "../../src/lib/prisma.js";
import { notificationsService } from "../../src/app/modules/notifications/notifications.service.js";

// What the worker's delivery relay and notification jobs do, run inline. Mock lib/mailer.js first.
export const sendPendingDeliveries = async () => {
  const due = await prisma.notificationDelivery.findMany({ where: { status: "PENDING", sendAfter: { lte: new Date() } } });
  for (const delivery of due) await notificationsService.sendDelivery(delivery.id);
  return due.length;
};

export const notificationsFor = (userId: string, type?: string) =>
  prisma.notification.findMany({ where: { userId, ...(type ? { type } : {}) }, include: { deliveries: true }, orderBy: { id: "asc" } });
