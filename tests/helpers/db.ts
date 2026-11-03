import { prisma } from "../../src/lib/prisma.js";

// audit_logs rejects TRUNCATE by design, so tests lift its triggers just long enough to clean up.
export const resetDatabase = () =>
  prisma.$transaction([
    prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER USER`),
    prisma.$executeRawUnsafe(
      `TRUNCATE audit_logs, refresh_tokens, user_sessions, mfa_factors, user_workspaces, users, workspaces RESTART IDENTITY CASCADE`,
    ),
    prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER USER`),
  ]);

export const auditActions = async () =>
  (await prisma.auditLog.findMany({ orderBy: { id: "asc" } })).map((row) => row.action);
