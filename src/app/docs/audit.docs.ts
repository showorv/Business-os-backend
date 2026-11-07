import { z } from "zod";
import { auditValidation } from "../modules/audit/audit.validation.js";
import { addPath } from "./registry.js";

// One recorded change: who did it, how (web, ai, system...), what it touched, and the values before and after.
const entry = z.object({
  id: z.string(),
  actorUserId: z.uuid().nullable(),
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: z.uuid().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
  actorVia: z.string(),
  requestId: z.string().nullable(),
  at: z.string(),
});
const page = z.object({ items: z.array(entry), nextCursor: z.string().nullable() });

addPath("Audit", { method: "get", path: "/audit/me", summary: "My own audit trail, newest first", query: auditValidation.listQuery, response: page });
addPath("Audit", { method: "get", path: "/businesses/{businessId}/audit", summary: "Audit trail of one business. Needs audit.read", params: z.object({ businessId: z.uuid() }), query: auditValidation.businessListQuery, response: page });
