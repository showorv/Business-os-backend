import type { z } from "zod";
import type { RoleKey } from "../../constants/permissions.js";
import type { membersValidation } from "./members.validation.js";

// Who is calling and what they may do. requireMembership puts this on req.business.
export interface BusinessContext {
  userId: string;
  workspaceId: string;
  businessId: string;
  businessStatus: "ACTIVE" | "INACTIVE" | "ARCHIVED";
  baseCurrency: string;
  timezone: string;
  fiscalYearStartMonth: number;
  memberId: string;
  roleKey: RoleKey;
  permissions: string[];
  // Beyond the workspace plan's business limit after the plan lapsed: readable, but nothing can change.
  planLocked?: boolean;
  // The platform admin suspended the workspace: nobody may open the business.
  workspaceSuspended?: boolean;
}

export interface IAddMemberInput {
  workspaceId: string;
  businessId: string;
  userId: string;
  roleId: string;
  createdBy: string;
}

export type IMemberParams = z.infer<typeof membersValidation.memberParams>;
export type IUpdateMemberBody = z.infer<typeof membersValidation.updateMember>;
