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

// Which queue handles each event. An event with no queue is only a record for now: budget and goal
// events get their consumers in Phase 6, when notifications exist.
export const EVENT_ROUTES: Partial<Record<EventType, QueueName>> = {
  [EventType.JOURNAL_POSTED]: QueueName.LEDGER_EVENTS,
  [EventType.REPORT_EXPORT_REQUESTED]: QueueName.REPORT_EXPORTS,
};
