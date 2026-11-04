import { z } from "zod";
import { Permission } from "../../constants/permissions.js";
import { roleKeyField } from "../roles/roles.validation.js";

const memberParams = z.object({ memberId: z.uuid() });

const updateMember = z
  .object({
    roleKey: roleKeyField.optional(),
    extraPermissions: z.array(z.enum(Object.values(Permission) as [Permission, ...Permission[]])).optional(),
  })
  .refine((body) => body.roleKey !== undefined || body.extraPermissions !== undefined, {
    message: "NO_FIELDS_TO_UPDATE",
  });

export const membersValidation = { memberParams, updateMember };
