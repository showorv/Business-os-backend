import { budgetsService } from "../modules/budgets/budgets.service.js";
import { goalsService } from "../modules/goals/goals.service.js";
import { reportExportsService } from "../modules/report-exports/report-exports.service.js";
import { EventType } from "../utils/outbox.js";
import type { EventJob } from "./eventTypes.js";

// What each event does. Handlers can safely run twice, because delivery is at-least-once.
export const processEvent = async (event: EventJob) => {
  const actor = { userId: event.actorUserId, workspaceId: event.workspaceId, businessId: event.businessId };

  switch (event.type) {
    case EventType.JOURNAL_POSTED:
      await budgetsService.checkThresholds(actor);
      await goalsService.checkProgress(actor);
      return;
    case EventType.REPORT_EXPORT_REQUESTED:
      await reportExportsService.run(event.payload.exportId!);
      return;
  }
};
