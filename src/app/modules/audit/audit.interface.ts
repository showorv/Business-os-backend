import type { z } from "zod";
import type { RequestContext } from "../../utils/requestContext.js";
import type { auditValidation } from "./audit.validation.js";

export type ActorVia = "web" | "api" | "ai" | "system";

export interface AuditEntry {
  action: string;
  context: RequestContext | null;
  workspaceId?: string | null;
  businessId?: string | null;
  actorUserId?: string | null;
  actorVia?: ActorVia;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface ChainVerification {
  workspaceId: string | null;
  checked: number;
  brokenAtId: string | null;
}

export type IListAuditQuery = z.infer<typeof auditValidation.listQuery>;
export type IListBusinessAuditQuery = z.infer<typeof auditValidation.businessListQuery>;
