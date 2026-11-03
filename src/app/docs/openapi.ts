import { OpenApiGeneratorV3, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { auditValidation } from "../modules/audit/audit.validation.js";
import { authValidation } from "../modules/auth/auth.validation.js";
import { usersValidation } from "../modules/users/users.validation.js";

const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

const publicUser = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  status: z.enum(["ACTIVE", "DISABLED"]),
  mfaEnabled: z.boolean(),
  locale: z.string(),
  digitStyle: z.string(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

const tokens = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  csrfToken: z.string(),
  user: publicUser,
});

const success = (data: z.ZodType) => z.object({ success: z.literal(true), data });

const errorBody = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), params: z.record(z.string(), z.unknown()).optional(), requestId: z.string() }),
});

interface PathSpec {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  body?: z.ZodObject | z.ZodType;
  query?: z.ZodObject;
  params?: z.ZodObject;
  response?: z.ZodType;
  status?: number;
  secured?: boolean;
  csrf?: boolean;
}

const add = (tag: string, spec: PathSpec) => {
  const secured = spec.secured ?? true;
  registry.registerPath({
    method: spec.method,
    path: `/api/v1${spec.path}`,
    tags: [tag],
    summary: spec.summary,
    ...(secured ? { security: [{ [bearerAuth.name]: [] }] } : {}),
    request: {
      ...(spec.body ? { body: { content: { "application/json": { schema: spec.body } } } } : {}),
      ...(spec.query ? { query: spec.query } : {}),
      ...(spec.params ? { params: spec.params } : {}),
      ...(spec.csrf ? { headers: z.object({ "x-csrf-token": z.string() }) } : {}),
    },
    responses: {
      [spec.status ?? 200]: {
        description: "Success",
        content: { "application/json": { schema: success(spec.response ?? z.object({})) } },
      },
      default: { description: "Error", content: { "application/json": { schema: errorBody } } },
    },
  });
};

const session = z.object({
  id: z.uuid(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  current: z.boolean(),
});

add("Auth", { method: "post", path: "/auth/register", summary: "Create an account and its workspace", body: authValidation.register, response: tokens, status: 201, secured: false });
add("Auth", {
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
add("Auth", { method: "post", path: "/auth/mfa/verify", summary: "Finish an MFA login", body: authValidation.mfaVerify, response: tokens, secured: false });
add("Auth", { method: "post", path: "/auth/refresh", summary: "Rotate the refresh cookie and get a new access token", response: tokens, secured: false, csrf: true });
add("Auth", { method: "post", path: "/auth/logout", summary: "End this session", secured: false, csrf: true });
add("Auth", { method: "post", path: "/auth/logout-all", summary: "End every session" });
add("Auth", { method: "get", path: "/auth/sessions", summary: "List active sessions", response: z.array(session) });
add("Auth", { method: "delete", path: "/auth/sessions/{sessionId}", summary: "End one session", params: authValidation.sessionParams });
add("Auth", { method: "post", path: "/auth/change-password", summary: "Change password. Ends every session and needs recent MFA if enabled", body: authValidation.changePassword });
add("MFA", { method: "post", path: "/auth/mfa/setup", summary: "Start TOTP setup, returns the secret and otpauth URI", body: authValidation.mfaSetup, response: z.object({ secret: z.string(), otpauthUri: z.string() }) });
add("MFA", { method: "post", path: "/auth/mfa/confirm", summary: "Confirm setup with a code from the app", body: authValidation.mfaCode });
add("MFA", { method: "post", path: "/auth/mfa/step-up", summary: "Prove MFA again for sensitive actions", body: authValidation.mfaCode, response: z.object({ accessToken: z.string(), expiresIn: z.number() }) });
add("MFA", { method: "post", path: "/auth/mfa/disable", summary: "Turn MFA off", body: authValidation.mfaDisable });
add("Users", { method: "get", path: "/users/me", summary: "Get my profile", response: publicUser });
add("Users", { method: "patch", path: "/users/me", summary: "Update name, language or digit style", body: usersValidation.updateMe, response: publicUser });
add("Audit", { method: "get", path: "/audit/me", summary: "My own audit trail, newest first", query: auditValidation.listQuery });

export const buildOpenApiDocument = () =>
  new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Business OS API",
      version: "1.0.0",
      description: "Phase 1: auth, users and audit. Errors return a code, never a display sentence.",
    },
  });
