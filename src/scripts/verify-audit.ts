// Run with `npm run audit:verify`. Exits 1 when a chain is broken.
// The worker also runs this check every night.
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { auditService } from "../app/modules/audit/audit.service.js";

const results = await auditService.verifyAllChains();
const broken = results.filter((result) => result.brokenAtId !== null);

for (const result of results) {
  logger.info(result, result.brokenAtId ? "audit chain BROKEN" : "audit chain ok");
}
logger.info({ chains: results.length, broken: broken.length }, "audit verification finished");

await prisma.$disconnect();
redis.disconnect();
process.exitCode = broken.length > 0 ? 1 : 0;
