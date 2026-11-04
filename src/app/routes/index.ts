import { Router } from "express";
import { accountsRouter } from "../modules/accounts/accounts.router.js";
import { auditRouter, businessAuditRouter } from "../modules/audit/audit.router.js";
import { authRouter } from "../modules/auth/auth.router.js";
import { businessesRouter } from "../modules/businesses/businesses.router.js";
import { categoriesRouter } from "../modules/categories/categories.router.js";
import { documentsRouter } from "../modules/documents/documents.router.js";
import { fiscalPeriodsRouter } from "../modules/fiscal-periods/fiscal-periods.router.js";
import { businessInvitationsRouter, invitationsRouter } from "../modules/invitations/invitations.router.js";
import { journalsRouter } from "../modules/journals/journals.router.js";
import { ledgerAccountsRouter } from "../modules/ledger-accounts/ledger-accounts.router.js";
import { membersRouter } from "../modules/members/members.router.js";
import { reconciliationsRouter } from "../modules/reconciliations/reconciliations.router.js";
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
  { path: "/businesses", router: businessesRouter },
  { path: "/businesses/:businessId/members", router: membersRouter },
  { path: "/businesses/:businessId/invitations", router: businessInvitationsRouter },
  { path: "/businesses/:businessId/audit", router: businessAuditRouter },
  { path: "/businesses/:businessId/accounts", router: accountsRouter },
  { path: "/businesses/:businessId/categories", router: categoriesRouter },
  { path: "/businesses/:businessId/documents", router: documentsRouter },
  { path: "/businesses/:businessId/transactions", router: transactionsRouter },
  { path: "/businesses/:businessId/ledger-accounts", router: ledgerAccountsRouter },
  { path: "/businesses/:businessId/fiscal-periods", router: fiscalPeriodsRouter },
  { path: "/businesses/:businessId/journals", router: journalsRouter },
  { path: "/businesses/:businessId/reports", router: reportsRouter },
  { path: "/businesses/:businessId/reconciliations", router: reconciliationsRouter },
];

const router = Router();

for (const { path, router: moduleRouter } of moduleRoutes) {
  router.use(path, moduleRouter);
}

export default router;
