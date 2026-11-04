import { Router } from "express";
import { requireAuth, requireRecentMfa } from "../../middlewares/auth.js";
import { csrfProtection } from "../../middlewares/csrf.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { validate } from "../../middlewares/validate.js";
import { authController } from "./auth.controller.js";
import { authValidation } from "./auth.validation.js";

const router = Router();

const sensitiveLimit = rateLimit({ name: "auth-sensitive", windowSeconds: 60, max: 10, by: "user" });

router.post(
  "/register",
  rateLimit({ name: "register", windowSeconds: 600, max: 10 }),
  validate({ body: authValidation.register }),
  authController.register,
);
router.post(
  "/login",
  rateLimit({ name: "login", windowSeconds: 60, max: 10 }),
  validate({ body: authValidation.login }),
  authController.login,
);
router.post(
  "/mfa/verify",
  rateLimit({ name: "mfa-verify", windowSeconds: 60, max: 10 }),
  validate({ body: authValidation.mfaVerify }),
  authController.verifyMfa,
);

// These two authenticate by cookie, so they carry the CSRF check instead of a Bearer token.
router.post("/refresh", rateLimit({ name: "refresh", windowSeconds: 60, max: 60 }), csrfProtection, authController.refresh);
router.post("/logout", rateLimit({ name: "logout", windowSeconds: 60, max: 60 }), csrfProtection, authController.logout);

router.post("/logout-all", requireAuth, authController.logoutAll);
router.get("/sessions", requireAuth, authController.listSessions);
router.delete(
  "/sessions/:sessionId",
  requireAuth,
  validate({ params: authValidation.sessionParams }),
  authController.revokeSession,
);

router.post("/mfa/setup", requireAuth, sensitiveLimit, validate({ body: authValidation.mfaSetup }), authController.startMfaSetup);
router.post("/mfa/confirm", requireAuth, sensitiveLimit, validate({ body: authValidation.mfaCode }), authController.confirmMfaSetup);
router.post("/mfa/disable", requireAuth, sensitiveLimit, validate({ body: authValidation.mfaDisable }), authController.disableMfa);
router.post("/mfa/step-up", requireAuth, sensitiveLimit, validate({ body: authValidation.mfaCode }), authController.stepUpMfa);

router.post(
  "/change-password",
  requireAuth,
  sensitiveLimit,
  requireRecentMfa,
  validate({ body: authValidation.changePassword }),
  authController.changePassword,
);

router.post(
  "/password/forgot",
  rateLimit({ name: "password-forgot", windowSeconds: 600, max: 5 }),
  validate({ body: authValidation.forgotPassword }),
  authController.forgotPassword,
);
router.post(
  "/password/reset",
  rateLimit({ name: "password-reset", windowSeconds: 600, max: 10 }),
  validate({ body: authValidation.resetPassword }),
  authController.resetPassword,
);

export const authRouter = router;
