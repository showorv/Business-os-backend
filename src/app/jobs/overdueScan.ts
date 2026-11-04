import { prisma } from "../../lib/prisma.js";
import { NotificationType } from "../modules/notifications/notifications.interface.js";
import { notificationsService } from "../modules/notifications/notifications.service.js";
import { localDateOf } from "../utils/rrule.js";

const BATCH_SIZE = 500;

// Runs every 15 minutes, but the key holds the local date, so each task notifies once a day.
export const scanOverdueTasks = async () => {
  const now = new Date();
  let cursor: string | undefined;
  let found = 0;

  for (;;) {
    const tasks = await prisma.task.findMany({
      where: {
        status: { in: ["TODO", "IN_PROGRESS", "BLOCKED"] },
        dueAt: { lt: now },
        business: { status: "ACTIVE" },
      },
      include: { business: { select: { timezone: true } } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    await notificationsService.notify(
      tasks.map((task) => {
        const userId = task.assigneeId ?? task.createdBy;
        return {
          type: NotificationType.TASK_OVERDUE,
          userId,
          workspaceId: task.workspaceId,
          businessId: task.businessId,
          params: { taskId: task.id, title: task.title, dueAt: task.dueAt!.toISOString(), timezone: task.business.timezone },
          entityType: "task",
          entityId: task.id,
          dedupeKey: `${NotificationType.TASK_OVERDUE}:${task.id}:${localDateOf(now, task.business.timezone)}:${userId}`,
        };
      }),
    );

    found += tasks.length;
    if (tasks.length < BATCH_SIZE) return found;
    cursor = tasks.at(-1)!.id;
  }
};
