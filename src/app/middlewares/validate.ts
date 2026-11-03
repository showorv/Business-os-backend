import type { RequestHandler } from "express";
import type { z } from "zod";
import { AppError, ErrorCode } from "../utils/errors.js";

interface ValidationSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

const describeIssue = (issue: z.core.$ZodIssue) => {
  const { code, path, message, input, ...params } = issue as z.core.$ZodIssue & Record<string, unknown>;
  return {
    field: path.join("."),
    // Custom rules carry their own code in `message`; Zod's own messages are English and stay out.
    code: code === "custom" ? issue.message : code.toUpperCase(),
    params,
  };
};

// Unknown keys are stripped by Zod. The clean result goes on req.validated for the controller.
export const validate = (schemas: ValidationSchemas): RequestHandler => {
  return (req, _res, next) => {
    const issues: z.core.$ZodIssue[] = [];
    req.validated = {};

    for (const part of ["params", "query", "body"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        req.validated[part] = result.data;
      } else {
        issues.push(...result.error.issues.map((issue) => ({ ...issue, path: [part, ...issue.path] })));
      }
    }

    if (issues.length > 0) {
      return next(new AppError(422, ErrorCode.VALIDATION_FAILED, { fields: issues.map(describeIssue) }));
    }
    next();
  };
};
