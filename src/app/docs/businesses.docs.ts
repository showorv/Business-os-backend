import { z } from "zod";
import { businessesValidation } from "../modules/businesses/businesses.validation.js";
import { invitationsValidation } from "../modules/invitations/invitations.validation.js";
import { membersValidation } from "../modules/members/members.validation.js";
import { planState } from "./billing.docs.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const memberParams = businessParams.extend(membersValidation.memberParams.shape);
const invitationParams = businessParams.extend(invitationsValidation.invitationParams.shape);

const business = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  legalName: z.string().nullable(),
  taxId: z.string().nullable(),
  type: z.string(),
  baseCurrency: z.string(),
  fiscalYearStartMonth: z.number(),
  timezone: z.string(),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]),
  settings: z.record(z.string(), z.unknown()),
});

const member = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  roleKey: z.string(),
  extraPermissions: z.array(z.string()),
  name: z.string().optional(),
  email: z.string().optional(),
});

addPath("Businesses", { method: "post", path: "/businesses", summary: "Create a business. The caller becomes its owner", body: businessesValidation.create, response: business, status: 201 });
addPath("Businesses", { method: "get", path: "/businesses", summary: "List my businesses, for the switcher", query: businessesValidation.listQuery, response: z.array(business.extend({ roleKey: z.string() })) });
addPath("Businesses", { method: "get", path: "/businesses/{businessId}", summary: "Get a business with my role and permissions", params: businessParams, response: business.extend({
  membership: z.object({ roleKey: z.string(), permissions: z.array(z.string()) }),
  // The plan of the workspace that owns this business. locked: beyond the plan's limit, so read-only.
  plan: z.object({ key: z.string(), name: z.string(), state: planState, aiEnabled: z.boolean(), locked: z.boolean() }),
}) });
addPath("Businesses", { method: "patch", path: "/businesses/{businessId}", summary: "Edit details and settings. Needs business.manage", params: businessParams, body: businessesValidation.update, response: business });
addPath("Businesses", { method: "post", path: "/businesses/{businessId}/status", summary: "Deactivate, archive or reactivate. Needs business.manage", params: businessParams, body: businessesValidation.changeStatus, response: business });

addPath("Members", { method: "get", path: "/businesses/{businessId}/members", summary: "List members", params: businessParams, response: z.array(member) });
addPath("Members", { method: "patch", path: "/businesses/{businessId}/members/{memberId}", summary: "Change role or optional grants. Needs members.manage and recent MFA", params: memberParams, body: membersValidation.updateMember });
addPath("Members", { method: "delete", path: "/businesses/{businessId}/members/{memberId}", summary: "Remove a member. Needs members.manage and recent MFA", params: memberParams });

addPath("Invitations", { method: "post", path: "/businesses/{businessId}/invitations", summary: "Invite by email. The token is returned once. Needs members.manage", params: businessParams, body: invitationsValidation.create, status: 201, response: z.object({ id: z.uuid(), email: z.string(), roleKey: z.string(), expiresAt: z.string(), token: z.string() }) });
addPath("Invitations", { method: "get", path: "/businesses/{businessId}/invitations", summary: "List pending invitations. Needs members.manage", params: businessParams });
addPath("Invitations", { method: "delete", path: "/businesses/{businessId}/invitations/{invitationId}", summary: "Revoke an invitation. Needs members.manage", params: invitationParams });
addPath("Invitations", { method: "post", path: "/invitations/accept", summary: "Join a business. The account email must match the invitation", body: invitationsValidation.accept, response: z.object({ businessId: z.uuid(), memberId: z.uuid() }) });

addPath("Roles", { method: "get", path: "/roles", summary: "System roles and their permissions", response: z.array(z.object({ key: z.string(), permissions: z.array(z.string()), optionalPermissions: z.array(z.string()) })) });
