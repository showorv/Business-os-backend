import { prisma } from "../../lib/prisma.js";
import { queues } from "../../lib/queues.js";
import type { EventType } from "../utils/outbox.js";
import { EVENT_ROUTES, type EventJob } from "./eventTypes.js";

const BATCH_SIZE = 100;

// Publishes saved events to BullMQ. If Redis is down, the transaction rolls back and the events wait
// for the next run. SKIP LOCKED lets several workers run this safely, and the job id stops a repeat
// publish from creating a second job, so events are delivered at least once and never lost.
export const relayOutbox = () =>
  prisma.$transaction(async (tx) => {
    const events = await tx.$queryRaw<
      { id: bigint; type: string; workspace_id: string; business_id: string; actor_user_id: string; payload: Record<string, string> }[]
    >`
      SELECT id, type, workspace_id, business_id, actor_user_id, payload
      FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY id
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED`;

    for (const event of events) {
      const queueName = EVENT_ROUTES[event.type as EventType];
      if (!queueName) continue;

      const job: EventJob = {
        eventId: event.id.toString(),
        type: event.type,
        workspaceId: event.workspace_id,
        businessId: event.business_id,
        actorUserId: event.actor_user_id,
        payload: event.payload,
      };
      await queues[queueName].add(event.type, job, { jobId: `event-${job.eventId}` });
    }

    if (events.length > 0) {
      await tx.outboxEvent.updateMany({
        where: { id: { in: events.map((event) => event.id) } },
        data: { publishedAt: new Date() },
      });
    }
    return events.length;
  });
