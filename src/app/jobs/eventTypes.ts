import { QueueName } from "../../lib/queues.js";
import { EventType } from "../utils/outbox.js";

export interface EventJob {
  eventId: string;
  type: string;
  workspaceId: string;
  businessId: string;
  actorUserId: string;
  payload: Record<string, string>;
}

// Which queue handles each event.
export const EVENT_ROUTES: Partial<Record<EventType, QueueName>> = {
  [EventType.JOURNAL_POSTED]: QueueName.LEDGER_EVENTS,
  [EventType.REPORT_EXPORT_REQUESTED]: QueueName.REPORT_EXPORTS,
  [EventType.BUDGET_THRESHOLD_REACHED]: QueueName.DOMAIN_EVENTS,
  [EventType.GOAL_ACHIEVED]: QueueName.DOMAIN_EVENTS,
  [EventType.TRANSACTION_SUBMITTED]: QueueName.DOMAIN_EVENTS,
  [EventType.TASK_ASSIGNED]: QueueName.DOMAIN_EVENTS,
  [EventType.TASK_COMMENTED]: QueueName.DOMAIN_EVENTS,
  [EventType.REMINDER_CHANGED]: QueueName.DOMAIN_EVENTS,
  [EventType.INVITATION_CREATED]: QueueName.DOMAIN_EVENTS,
  [EventType.STATEMENT_IMPORT_REQUESTED]: QueueName.INTEGRATIONS,
  [EventType.INTEGRATION_SYNC_REQUESTED]: QueueName.INTEGRATIONS,
};
