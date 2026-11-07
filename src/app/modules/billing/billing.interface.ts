import type { Plan, WorkspaceSubscription } from "../../../generated/prisma/client.js";
import type { z } from "zod";
import type { billingValidation } from "./billing.validation.js";

// Where a workspace stands. "grace": a paid plan has ended but still works for a few days.
// "expired": a trial or paid plan ended, so the workspace is on Free now.
export type PlanState = "free" | "trial" | "active" | "grace" | "expired" | "granted";

export interface Entitlements {
  plan: Plan;
  state: PlanState;
  subscription: WorkspaceSubscription | null;
  // When a paid plan in its grace period stops working.
  graceEndsAt: Date | null;
}

export type PlanLimit = "businesses" | "members" | "storage";

export type IPlansQuery = z.infer<typeof billingValidation.plansQuery>;
