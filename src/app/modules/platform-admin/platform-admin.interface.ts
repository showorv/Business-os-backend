import type { z } from "zod";
import type { platformAdminValidation as v } from "./platform-admin.validation.js";

export type IWorkspacesQuery = z.infer<typeof v.workspacesQuery>;
export type IWorkspaceParams = z.infer<typeof v.workspaceParams>;
export type ISetSubscriptionBody = z.infer<typeof v.setSubscription>;
export type ISuspendBody = z.infer<typeof v.suspend>;
export type IUsersQuery = z.infer<typeof v.usersQuery>;
export type ICreatePlanBody = z.infer<typeof v.createPlan>;
export type IUpdatePlanBody = z.infer<typeof v.updatePlan>;
export type IPlanParams = z.infer<typeof v.planParams>;
export type ICreateCouponBody = z.infer<typeof v.createCoupon>;
export type IUpdateCouponBody = z.infer<typeof v.updateCoupon>;
export type ICouponParams = z.infer<typeof v.couponParams>;
export type IPaymentsQuery = z.infer<typeof v.paymentsQuery>;
export type IActivityQuery = z.infer<typeof v.activityQuery>;

// Who is acting in the admin panel, for the audit log.
export interface AdminActor {
  userId: string;
}
