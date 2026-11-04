import { z } from "zod";
import { RoleKey } from "../../constants/permissions.js";
import { emailField } from "../../utils/validationFields.js";

// OWNER is left out: ownership is given to an existing member, never through an emailed token.
const invitableRole = z.enum([RoleKey.ADMIN, RoleKey.ACCOUNTANT, RoleKey.MANAGER, RoleKey.VIEWER]);

const create = z.object({ email: emailField, roleKey: invitableRole });
const invitationParams = z.object({ invitationId: z.uuid() });
const accept = z.object({ token: z.string().min(1).max(200) });

export const invitationsValidation = { create, invitationParams, accept };
