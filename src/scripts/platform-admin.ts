// Makes someone a platform admin, or takes it away:
//   npm run admin:grant -- someone@example.com
//   npm run admin:revoke -- someone@example.com
// They also need two-step verification turned on before the admin panel opens for them.
import { auditService } from "../app/modules/audit/audit.service.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

const [mode, email] = process.argv.slice(2);
if ((mode !== "grant" && mode !== "revoke") || !email) {
  logger.error("usage: tsx src/scripts/platform-admin.ts grant|revoke someone@example.com");
  process.exit(1);
}

const user = await prisma.user.findUnique({ where: { email }, select: { id: true, mfaEnabled: true } });
if (!user) {
  logger.error({ email }, "no account with that email");
  process.exitCode = 1;
} else {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { isPlatformAdmin: mode === "grant" } });
    await auditService.record(tx, {
      action: mode === "grant" ? "platform.admin_granted" : "platform.admin_revoked",
      context: null,
      actorVia: "system",
      entityType: "user",
      entityId: user.id,
      after: { email },
    });
  });
  logger.info({ email, mfaEnabled: user.mfaEnabled }, mode === "grant" ? "now a platform admin" : "no longer a platform admin");
  if (mode === "grant" && !user.mfaEnabled) logger.warn("turn on two-step verification in Settings → Security before opening the admin panel");
}

await prisma.$disconnect();
redis.disconnect();
