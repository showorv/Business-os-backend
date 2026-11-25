// Makes someone a platform admin, or takes it away:
//   npm run admin:grant -- someone@example.com
//   npm run admin:revoke -- someone@example.com
import { auditService } from "../app/modules/audit/audit.service.js";
import { platformAdminService } from "../app/modules/platform-admin/platform-admin.service.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

const [mode, email] = process.argv.slice(2);
if ((mode !== "grant" && mode !== "revoke") || !email) {
  logger.error("usage: tsx src/scripts/platform-admin.ts grant|revoke someone@example.com");
  process.exit(1);
}

const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
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
  // An admin never pays: their own workspace gets the paid plan free, with no end date.
  if (mode === "grant") await platformAdminService.giveAdminPlan(user.id);
  logger.info({ email }, mode === "grant" ? "now a platform admin" : "no longer a platform admin");
}

await prisma.$disconnect();
redis.disconnect();
