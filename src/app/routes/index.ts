import { Router } from "express";
import { auditRouter, businessAuditRouter } from "../modules/audit/audit.router.js";
import { authRouter } from "../modules/auth/auth.router.js";
import { businessesRouter } from "../modules/businesses/businesses.router.js";
import { businessInvitationsRouter, invitationsRouter } from "../modules/invitations/invitations.router.js";
import { membersRouter } from "../modules/members/members.router.js";
import { rolesRouter } from "../modules/roles/roles.router.js";
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
];

const router = Router();

for (const { path, router: moduleRouter } of moduleRoutes) {
  router.use(path, moduleRouter);
}

export default router;
