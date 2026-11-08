import { Router } from "express";
import { accountsRouter } from "../modules/accounts/accounts.router.js";
import { analyticsRouter } from "../modules/analytics/analytics.router.js";
import { auditRouter, businessAuditRouter } from "../modules/audit/audit.router.js";
import { authRouter } from "../modules/auth/auth.router.js";
import { billingRouter } from "../modules/billing/billing.router.js";
import { platformRouter } from "../modules/platform/platform.router.js";
import { platformAdminRouter } from "../modules/platform-admin/platform-admin.router.js";
import { budgetsRouter } from "../modules/budgets/budgets.router.js";
import { businessesRouter } from "../modules/businesses/businesses.router.js";
import { categoriesRouter } from "../modules/categories/categories.router.js";
import { contactsRouter } from "../modules/contacts/contacts.router.js";
import { invoicesRouter } from "../modules/invoices/invoices.router.js";
import { itemsRouter } from "../modules/items/items.router.js";
import { vatRouter } from "../modules/vat/vat.router.js";
import { consolidatedRouter } from "../modules/consolidated/consolidated.router.js";
import { documentsRouter } from "../modules/documents/documents.router.js";
import { exchangeRatesRouter } from "../modules/exchange-rates/exchange-rates.router.js";
import { fiscalPeriodsRouter } from "../modules/fiscal-periods/fiscal-periods.router.js";
import { goalsRouter } from "../modules/goals/goals.router.js";
import { businessInvitationsRouter, invitationsRouter } from "../modules/invitations/invitations.router.js";
import { journalsRouter } from "../modules/journals/journals.router.js";
import { ledgerAccountsRouter } from "../modules/ledger-accounts/ledger-accounts.router.js";
import { membersRouter } from "../modules/members/members.router.js";
import { notificationsRouter } from "../modules/notifications/notifications.router.js";
import { recurringSchedulesRouter } from "../modules/recurring-schedules/recurring-schedules.router.js";
import { remindersRouter } from "../modules/reminders/reminders.router.js";
import { allTasksRouter, tasksRouter } from "../modules/tasks/tasks.router.js";
import { aiRouter } from "../modules/ai/ai.router.js";
import { integrationsRouter } from "../modules/integrations/integrations.router.js";
import { statementImportsRouter } from "../modules/statement-imports/statement-imports.router.js";
import { statementLinesRouter } from "../modules/statement-lines/statement-lines.router.js";
import { statementRulesRouter } from "../modules/statement-rules/statement-rules.router.js";
import { statementTemplatesRouter } from "../modules/statement-templates/statement-templates.router.js";
import { reconciliationsRouter } from "../modules/reconciliations/reconciliations.router.js";
import { reportExportsRouter } from "../modules/report-exports/report-exports.router.js";
import { reportsRouter } from "../modules/reports/reports.router.js";
import { rolesRouter } from "../modules/roles/roles.router.js";
import { transactionsRouter } from "../modules/transactions/transactions.router.js";
import { usersRouter } from "../modules/users/users.router.js";

// The module registry: a new module is a new folder plus one line here.
const moduleRoutes = [
  { path: "/auth", router: authRouter },
  { path: "/users", router: usersRouter },
  { path: "/audit", router: auditRouter },
  { path: "/roles", router: rolesRouter },
  { path: "/invitations", router: invitationsRouter },
  { path: "/exchange-rates", router: exchangeRatesRouter },
  { path: "/consolidated", router: consolidatedRouter },
  { path: "/notifications", router: notificationsRouter },
  { path: "/ai", router: aiRouter },
  { path: "/billing", router: billingRouter },
  { path: "/platform", router: platformRouter },
  { path: "/admin", router: platformAdminRouter },
  { path: "/tasks", router: allTasksRouter },
  { path: "/businesses", router: businessesRouter },
  { path: "/businesses/:businessId/members", router: membersRouter },
  { path: "/businesses/:businessId/invitations", router: businessInvitationsRouter },
  { path: "/businesses/:businessId/audit", router: businessAuditRouter },
  { path: "/businesses/:businessId/accounts", router: accountsRouter },
  { path: "/businesses/:businessId/categories", router: categoriesRouter },
  { path: "/businesses/:businessId/contacts", router: contactsRouter },
  { path: "/businesses/:businessId/invoices", router: invoicesRouter },
  { path: "/businesses/:businessId/vat", router: vatRouter },
  { path: "/businesses/:businessId/items", router: itemsRouter },
  { path: "/businesses/:businessId/documents", router: documentsRouter },
  { path: "/businesses/:businessId/transactions", router: transactionsRouter },
  { path: "/businesses/:businessId/ledger-accounts", router: ledgerAccountsRouter },
  { path: "/businesses/:businessId/fiscal-periods", router: fiscalPeriodsRouter },
  { path: "/businesses/:businessId/journals", router: journalsRouter },
  { path: "/businesses/:businessId/reports", router: reportsRouter },
  { path: "/businesses/:businessId/reconciliations", router: reconciliationsRouter },
  { path: "/businesses/:businessId/analytics", router: analyticsRouter },
  { path: "/businesses/:businessId/budgets", router: budgetsRouter },
  { path: "/businesses/:businessId/goals", router: goalsRouter },
  { path: "/businesses/:businessId/report-exports", router: reportExportsRouter },
  { path: "/businesses/:businessId/tasks", router: tasksRouter },
  { path: "/businesses/:businessId/reminders", router: remindersRouter },
  { path: "/businesses/:businessId/recurring-schedules", router: recurringSchedulesRouter },
  { path: "/businesses/:businessId/integrations", router: integrationsRouter },
  { path: "/businesses/:businessId/statement-templates", router: statementTemplatesRouter },
  { path: "/businesses/:businessId/statement-imports", router: statementImportsRouter },
  { path: "/businesses/:businessId/statement-lines", router: statementLinesRouter },
  { path: "/businesses/:businessId/statement-rules", router: statementRulesRouter },
];

const router = Router();

for (const { path, router: moduleRouter } of moduleRoutes) {
  router.use(path, moduleRouter);
}

export default router;
