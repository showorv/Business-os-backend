import { prisma } from "../../src/lib/prisma.js";

// audit_logs rejects TRUNCATE by design, so tests lift its triggers just long enough to clean up.
// DELETE for the rest, because TRUNCATE ... CASCADE would also wipe the roles seeded by migration.
export const resetDatabase = () =>
  prisma.$transaction([
    prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER USER`),
    prisma.$executeRawUnsafe(`TRUNCATE audit_logs RESTART IDENTITY`),
    prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER USER`),
    prisma.$executeRawUnsafe(`DELETE FROM invitations`),
    prisma.$executeRawUnsafe(`DELETE FROM business_members`),
    prisma.$executeRawUnsafe(`DELETE FROM businesses`),
    prisma.$executeRawUnsafe(`DELETE FROM users`),
    prisma.$executeRawUnsafe(`DELETE FROM workspaces`),
  ]);

export const auditActions = async () =>
  (await prisma.auditLog.findMany({ orderBy: { id: "asc" } })).map((row) => row.action);
