import { z } from "zod";
import { authValidation } from "../modules/auth/auth.validation.js";
import { addPath, tokens } from "./registry.js";

const session = z.object({
  id: z.uuid(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  current: z.boolean(),
});

addPath("Auth", { method: "post", path: "/auth/register", summary: "Create an account and its workspace", body: authValidation.register, response: tokens, status: 201, secured: false });
addPath("Auth", {
  method: "post",
  path: "/auth/login",
  summary: "Log in. With MFA on, returns a challenge token instead of tokens",
  body: authValidation.login,
  response: z.union([
    tokens.extend({ mfaRequired: z.literal(false) }),
    z.object({ mfaRequired: z.literal(true), challengeToken: z.string() }),
  ]),
  secured: false,
});
addPath("Auth", { method: "post", path: "/auth/mfa/verify", summary: "Finish an MFA login", body: authValidation.mfaVerify, response: tokens, secured: false });
addPath("Auth", { method: "post", path: "/auth/refresh", summary: "Rotate the refresh cookie and get a new access token", response: tokens, secured: false, csrf: true });
addPath("Auth", { method: "post", path: "/auth/logout", summary: "End this session", secured: false, csrf: true });
addPath("Auth", { method: "post", path: "/auth/logout-all", summary: "End every session" });
addPath("Auth", { method: "get", path: "/auth/sessions", summary: "List active sessions", response: z.array(session) });
addPath("Auth", { method: "delete", path: "/auth/sessions/{sessionId}", summary: "End one session", params: authValidation.sessionParams });
addPath("Auth", { method: "post", path: "/auth/change-password", summary: "Change password. Ends every session and needs recent MFA if enabled", body: authValidation.changePassword });
addPath("MFA", { method: "post", path: "/auth/mfa/setup", summary: "Start TOTP setup, returns the secret and otpauth URI", body: authValidation.mfaSetup, response: z.object({ secret: z.string(), otpauthUri: z.string() }) });
addPath("MFA", { method: "post", path: "/auth/mfa/confirm", summary: "Confirm setup with a code from the app", body: authValidation.mfaCode });
addPath("MFA", { method: "post", path: "/auth/mfa/step-up", summary: "Prove MFA again for sensitive actions", body: authValidation.mfaCode, response: z.object({ accessToken: z.string(), expiresIn: z.number() }) });
addPath("MFA", { method: "post", path: "/auth/mfa/disable", summary: "Turn MFA off", body: authValidation.mfaDisable });
