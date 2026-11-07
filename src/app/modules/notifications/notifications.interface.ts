import type { z } from "zod";
import type { notificationsValidation } from "./notifications.validation.js";

export type INotificationParams = z.infer<typeof notificationsValidation.notificationParams>;
export type ISubscriptionParams = z.infer<typeof notificationsValidation.subscriptionParams>;
export type IListNotificationsQuery = z.infer<typeof notificationsValidation.listQuery>;
export type IUpdatePreferencesBody = z.infer<typeof notificationsValidation.updatePreferences>;
export type IPushSubscribeBody = z.infer<typeof notificationsValidation.pushSubscribe>;

export const NotificationType = {
  TASK_ASSIGNED: "task.assigned",
  TASK_COMMENTED: "task.commented",
  TASK_OVERDUE: "task.overdue",
  REMINDER_DUE: "reminder.due",
  TRANSACTION_PENDING_APPROVAL: "transaction.pending_approval",
  BUDGET_THRESHOLD: "budget.threshold",
  GOAL_ACHIEVED: "goal.achieved",
  EXPORT_READY: "export.ready",
  EXPORT_FAILED: "export.failed",
  RECURRING_FAILED: "recurring.failed",
  LEDGER_CHECK_FAILED: "ledger.check_failed",
  AUDIT_CHECK_FAILED: "audit.check_failed",
  STATEMENT_IMPORT_FINISHED: "statement_import.finished",
  INTEGRATION_NEEDS_REAUTH: "integration.needs_reauth",
  INTEGRATION_SYNC_FAILING: "integration.sync_failing",
  INVITATION: "invitation",
  PAYMENT_RECEIVED: "billing.payment_received",
  PLAN_ENDING: "billing.plan_ending",
  PLAN_ENDED: "billing.plan_ended",
  PASSWORD_RESET: "auth.password_reset",
  PASSWORD_CHANGED: "auth.password_changed",
  ACCOUNT_LOCKED: "auth.account_locked",
  SESSION_REUSE_DETECTED: "auth.session_reuse_detected",
} as const;

export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export type NotificationChannel = "IN_APP" | "EMAIL" | "PUSH";

export type NotificationParams = Record<string, string | number | null>;

export interface NotificationInput {
  type: NotificationType;
  // Someone with an account. An invitation may go to someone without one, using `email` and `locale`.
  userId?: string;
  email?: string;
  locale?: string;
  workspaceId?: string;
  businessId?: string;
  params: NotificationParams;
  entityType?: string;
  entityId?: string;
  dedupeKey: string;
  // Replaces the type's usual channels, such as the channels chosen on a reminder.
  channels?: NotificationChannel[];
}
