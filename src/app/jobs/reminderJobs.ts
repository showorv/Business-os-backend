import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { QueueName, queues } from "../../lib/queues.js";
import { NotificationType, type NotificationChannel } from "../modules/notifications/notifications.interface.js";
import { notificationsService } from "../modules/notifications/notifications.service.js";
import { nextFiring } from "../utils/rrule.js";

export interface ReminderJob {
  reminderId: string;
  fireAt: string;
}

const RECONCILE_BATCH = 500;
// A job this late with nothing having moved nextFireAt on has probably failed for good.
const LATE_AFTER_MS = 60 * 1000;

const jobIdOf = (reminderId: string, fireAt: Date) => `reminder-${reminderId}-${fireAt.getTime()}`;

// The job id comes from the reminder and its time, so repeating this never makes a second job.
export const scheduleFiring = (reminderId: string, fireAt: Date) =>
  queues[QueueName.REMINDERS].add(
    "reminder.fire",
    { reminderId, fireAt: fireAt.toISOString() } satisfies ReminderJob,
    { jobId: jobIdOf(reminderId, fireAt), delay: Math.max(0, fireAt.getTime() - Date.now()) },
  );

// Called when a reminder was created or changed.
export const scheduleReminder = async (reminderId: string) => {
  const reminder = await prisma.reminder.findUnique({ where: { id: reminderId }, select: { status: true, nextFireAt: true } });
  if (reminder?.status === "ACTIVE" && reminder.nextFireAt) await scheduleFiring(reminderId, reminder.nextFireAt);
};

// Fires one occurrence. A job whose reminder was paused or moved since it was queued is discarded,
// which is why editing a reminder doesn't need to find and delete the old job.
export const fireReminder = async ({ reminderId, fireAt }: ReminderJob) => {
  const scheduledFor = new Date(fireAt);

  const outcome = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM reminders WHERE id = ${reminderId}::uuid FOR UPDATE`;
    if (!locked) return null;

    const reminder = await tx.reminder.findUniqueOrThrow({
      where: { id: reminderId },
      include: { business: { select: { status: true } } },
    });
    if (reminder.status !== "ACTIVE" || reminder.nextFireAt?.getTime() !== scheduledFor.getTime()) return null;

    // Someone removed from the business, or a closed business, gets no message. The rule still moves on.
    const member = await tx.businessMember.findUnique({
      where: { businessId_userId: { businessId: reminder.businessId, userId: reminder.recipientUserId } },
      select: { status: true },
    });
    const shouldSend = member?.status === "ACTIVE" && reminder.business.status === "ACTIVE";

    const created = shouldSend
      ? await notificationsService.dispatch(tx, [
          {
            type: NotificationType.REMINDER_DUE,
            userId: reminder.recipientUserId,
            workspaceId: reminder.workspaceId,
            businessId: reminder.businessId,
            params: {
              reminderId,
              title: reminder.title,
              occurrenceAt: reminder.nextOccurrenceAt!.toISOString(),
              timezone: reminder.timezone,
              sourceType: reminder.sourceType,
              sourceId: reminder.sourceId,
            },
            entityType: reminder.sourceType === "TASK" ? "task" : "reminder",
            entityId: reminder.sourceType === "TASK" ? reminder.sourceId! : reminderId,
            channels: reminder.channels as NotificationChannel[],
            dedupeKey: `reminder:${reminderId}:${scheduledFor.getTime()}:${reminder.recipientUserId}`,
          },
        ])
      : [];

    // Looks forward from now, so a worker that was down for a week sends one message, not seven. Never
    // from before this firing: a job running a moment early would otherwise find the same one again.
    const after = new Date(Math.max(Date.now(), scheduledFor.getTime()));
    const next = reminder.rrule ? nextFiring(reminder, reminder.leadMinutes, after) : null;
    await tx.reminder.update({
      where: { id: reminderId },
      data: {
        lastFiredAt: new Date(),
        nextOccurrenceAt: next?.occurrenceAt ?? null,
        nextFireAt: next?.fireAt ?? null,
        status: next ? "ACTIVE" : "COMPLETED",
      },
    });
    return { created, nextFireAt: next?.fireAt ?? null };
  });

  if (!outcome) return;
  await notificationsService.publishInApp(outcome.created);
  if (outcome.nextFireAt) await scheduleFiring(reminderId, outcome.nextFireAt);
};

// Every few minutes, rebuilds any job missing from Redis. The database is the source of truth, so
// even an empty Redis loses no reminders.
export const reconcileReminders = async () => {
  let cursor: string | undefined;
  let checked = 0;

  for (;;) {
    const page = await prisma.reminder.findMany({
      where: { status: "ACTIVE", nextFireAt: { not: null } },
      select: { id: true, nextFireAt: true },
      orderBy: { id: "asc" },
      take: RECONCILE_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    for (const reminder of page) {
      const fireAt = reminder.nextFireAt!;
      // A job that failed for good keeps its id, and that id would block a new job.
      if (fireAt.getTime() < Date.now() - LATE_AFTER_MS) {
        const job = await queues[QueueName.REMINDERS].getJob(jobIdOf(reminder.id, fireAt));
        if (job && (await job.isFailed())) {
          logger.warn({ reminder_id: reminder.id }, "retrying a reminder whose job had failed");
          await job.remove();
        }
      }
      await scheduleFiring(reminder.id, fireAt);
    }

    checked += page.length;
    if (page.length < RECONCILE_BATCH) return checked;
    cursor = page.at(-1)!.id;
  }
};
