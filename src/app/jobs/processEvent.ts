import { ingestionService } from "../ai/ingestion.js";
import { budgetsService } from "../modules/budgets/budgets.service.js";
import { goalsService } from "../modules/goals/goals.service.js";
import { reportExportsService } from "../modules/report-exports/report-exports.service.js";
import { statementImportsService } from "../modules/statement-imports/statement-imports.service.js";
import { statementLinesService } from "../modules/statement-lines/statement-lines.service.js";
import { EventType } from "../utils/outbox.js";
import {
  emailInvitation,
  tellAboutBudget,
  tellAboutGoal,
  tellApprovers,
  tellTaskAssignee,
  tellTaskPeople,
} from "./domainEvents.js";
import type { EventJob } from "./eventTypes.js";
import { runSync } from "./integrationSync.js";
import { scheduleReminder } from "./reminderJobs.js";

// What each event does. Handlers can safely run twice, because delivery is at-least-once.
export const processEvent = async (event: EventJob) => {
  const actor = { userId: event.actorUserId, workspaceId: event.workspaceId, businessId: event.businessId };

  switch (event.type) {
    case EventType.JOURNAL_POSTED:
      await budgetsService.checkThresholds(actor);
      await goalsService.checkProgress(actor);
      // A draft linked to a statement line may just have reached the ledger.
      await statementLinesService.settlePendingLinks(event.businessId);
      return;
    case EventType.REPORT_EXPORT_REQUESTED:
      await reportExportsService.run(event.payload.exportId!);
      return;
    case EventType.BUDGET_THRESHOLD_REACHED:
      await tellAboutBudget(event);
      return;
    case EventType.GOAL_ACHIEVED:
      await tellAboutGoal(event);
      return;
    case EventType.TRANSACTION_SUBMITTED:
      await tellApprovers(event);
      return;
    case EventType.TASK_ASSIGNED:
      await tellTaskAssignee(event);
      return;
    case EventType.TASK_COMMENTED:
      await tellTaskPeople(event);
      return;
    case EventType.REMINDER_CHANGED:
      await scheduleReminder(event.payload.reminderId!);
      return;
    case EventType.INVITATION_CREATED:
      await emailInvitation(event);
      return;
    case EventType.STATEMENT_IMPORT_REQUESTED:
      await statementImportsService.run(event.payload.importId!);
      return;
    case EventType.DOCUMENT_UPLOADED:
      await ingestionService.ingest(event.payload.documentId!);
      return;
    case EventType.INTEGRATION_SYNC_REQUESTED:
      await runSync(event.payload.connectionId!);
      return;
  }
};
