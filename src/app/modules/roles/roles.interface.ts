import type { RoleKey } from "../../constants/permissions.js";

export interface ISystemRole {
  key: RoleKey;
  permissions: string[];
  optionalPermissions: string[];
}
