import { prisma } from "../../lib/prisma.js";
import { QueueName, queues } from "../../lib/queues.js";

const BATCH_SIZE = 100;

const addSendJob = (deliveryId: string) =>
  queues[QueueName.NOTIFICATIONS].add("notification.send", { deliveryId }, { jobId: `delivery-${deliveryId}` });

// Works like the outbox relay: sends that are due move to BullMQ. If Redis is down the transaction
// rolls back, and they go out on the next run.
export const relayDeliveries = () =>
  prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM notification_deliveries
      WHERE status = 'PENDING' AND send_after <= ${new Date()}
      ORDER BY id
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED`;

    for (const { id } of due) await addSendJob(id);

    if (due.length > 0) {
      await tx.notificationDelivery.updateMany({
        where: { id: { in: due.map(({ id }) => id) } },
        data: { status: "QUEUED", queuedAt: new Date() },
      });
    }
    return due.length;
  });

// Sends marked QUEUED that never finished, which is what emptying Redis leaves behind. The job id
// stops this making a second job for a send that is only slow.
const STUCK_AFTER_MS = 15 * 60 * 1000;

export const requeueStuckDeliveries = async () => {
  const stuck = await prisma.notificationDelivery.findMany({
    where: { status: "QUEUED", queuedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } },
    select: { id: true },
    take: BATCH_SIZE,
  });
  for (const { id } of stuck) await addSendJob(id);
  return stuck.length;
};
