import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { OPTIONAL_PERMISSIONS, RoleKey } from "../../constants/permissions.js";
import type { ISystemRole } from "./roles.interface.js";

const ROLE_ORDER = Object.values(RoleKey);

const getSystemRole = (tx: Prisma.TransactionClient, key: RoleKey) =>
  tx.role.findFirstOrThrow({ where: { key, workspaceId: null } });

const listSystemRoles = async (): Promise<ISystemRole[]> => {
  const roles = await prisma.role.findMany({
    where: { workspaceId: null },
    include: { permissions: { select: { permissionKey: true } } },
  });

  return roles
    .map((role) => ({
      key: role.key as RoleKey,
      permissions: role.permissions.map((item) => item.permissionKey).sort(),
      optionalPermissions: OPTIONAL_PERMISSIONS[role.key as RoleKey] ?? [],
    }))
    .sort((a, b) => ROLE_ORDER.indexOf(a.key) - ROLE_ORDER.indexOf(b.key));
};

export const rolesService = { getSystemRole, listSystemRoles };
