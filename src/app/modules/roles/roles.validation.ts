import { z } from "zod";
import { RoleKey } from "../../constants/permissions.js";

export const roleKeyField = z.enum(Object.values(RoleKey) as [RoleKey, ...RoleKey[]]);

export const rolesValidation = { roleKeyField };
