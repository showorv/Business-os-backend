import type { Prisma } from "../../lib/prisma.js";

export const EventType = {
  JOURNAL_POSTED: "journal.posted",
  REPORT_EXPORT_REQUESTED: "report_export.requested",
  BUDGET_THRESHOLD_REACHED: "budget.threshold_reached",
  GOAL_ACHIEVED: "goal.achieved",
  TRANSACTION_SUBMITTED: "transaction.submitted",
  TASK_ASSIGNED: "task.assigned",
  TASK_COMMENTED: "task.commented",
  REMINDER_CHANGED: "reminder.changed",
  INVITATION_CREATED: "invitation.created",
  STATEMENT_IMPORT_REQUESTED: "statement_import.requested",
  INTEGRATION_SYNC_REQUESTED: "integration_sync.requested",
  DOCUMENT_UPLOADED: "document.uploaded",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface EventActor {
  userId: string;
  workspaceId: string;
  businessId: string;
}

// Saves the event in the caller's transaction, so it exists if and only if the change committed.
// The worker publishes it to BullMQ afterwards. See src/app/jobs/outboxRelay.ts.
export const publishEvent = (
  tx: Prisma.TransactionClient,
  actor: EventActor,
  type: EventType,
  payload: Record<string, string | number | bigint | null>,
) =>
  tx.outboxEvent.createMany({
    data: {
      workspaceId: actor.workspaceId,
      businessId: actor.businessId,
      actorUserId: actor.userId,
      type,
      payload: JSON.parse(JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value))),
    },
  });
