import { z } from "zod";
import { auditValidation } from "../modules/audit/audit.validation.js";
import { addPath } from "./registry.js";

addPath("Audit", { method: "get", path: "/audit/me", summary: "My own audit trail, newest first", query: auditValidation.listQuery });
addPath("Audit", { method: "get", path: "/businesses/{businessId}/audit", summary: "Audit trail of one business. Needs audit.read", params: z.object({ businessId: z.uuid() }), query: auditValidation.businessListQuery });
