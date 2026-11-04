import type { Prisma } from "./prisma.js";
import { prisma } from "./prisma.js";

// Created by migration. Unlike the connecting role, it cannot bypass Row-Level Security.
const RESTRICTED_DB_ROLE = "business_os_app";

export interface RlsScope {
  userId: string;
  workspaceId?: string;
  businessIds: string[];
}

// Runs `work` in a transaction where PostgreSQL itself hides every business outside the scope,
// so a query with a forgotten WHERE still cannot return another business's rows.
// All settings are transaction-local, which also keeps them safe on a pooled connection.
export const withRls = <T>(scope: RlsScope, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT
        set_config('role', ${RESTRICTED_DB_ROLE}, true),
        set_config('app.user_id', ${scope.userId}, true),
        set_config('app.workspace_id', ${scope.workspaceId ?? ""}, true),
        set_config('app.business_ids', ${`{${scope.businessIds.join(",")}}`}, true)`;
    return work(tx);
  });

// The usual form: everything under /businesses/:businessId runs in exactly one business.
export const withBusinessScope = <T>(
  business: { userId: string; workspaceId: string; businessId: string },
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) =>
  withRls({ userId: business.userId, workspaceId: business.workspaceId, businessIds: [business.businessId] }, work);
