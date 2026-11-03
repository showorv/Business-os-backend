import { Router } from "express";
import { auditRouter } from "../modules/audit/audit.router.js";
import { authRouter } from "../modules/auth/auth.router.js";
import { usersRouter } from "../modules/users/users.router.js";

// The module registry: a new module is a new folder plus one line here.
const moduleRoutes = [
  { path: "/auth", router: authRouter },
  { path: "/users", router: usersRouter },
  { path: "/audit", router: auditRouter },
];

const router = Router();

for (const { path, router: moduleRouter } of moduleRoutes) {
  router.use(path, moduleRouter);
}

export default router;
