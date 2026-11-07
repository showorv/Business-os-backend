import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Shared by every *.docs.ts file. Each route is one addPath() call.
export const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

export const publicUser = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  status: z.enum(["ACTIVE", "DISABLED"]),
  mfaEnabled: z.boolean(),
  isPlatformAdmin: z.boolean(),
  locale: z.string(),
  digitStyle: z.string(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export const tokens = z.object({
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
  idempotent?: boolean;
}

export const addPath = (tag: string, spec: PathSpec) => {
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
      ...(spec.idempotent ? { headers: z.object({ "idempotency-key": z.string().optional() }) } : {}),
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
